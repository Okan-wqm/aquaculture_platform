/**
 * NATS SSoT Invariants
 * ============================================================================
 *
 * Enforces the architectural invariants established by the 2026-04-14
 * NATS cert-is-identity refactor (ADR-015) and the 2026-07-02 subject-scheme
 * remediation (ORPHAN-HIGH-317). Every downstream artifact that references
 * per-service NATS identity or subject grants must agree with the single
 * source of truth at `infrastructure/nats/services.yaml`.
 *
 * # What it checks
 *
 *   1. services.yaml is valid against services.schema.json (which now
 *      STRUCTURALLY rejects the legacy `AQUACULTURE_EVENTS.` subject prefix —
 *      that string is the JetStream stream NAME, never a subject).
 *   2. Every service in services.yaml has a matching `user: "CN=<name>"`
 *      entry in nats.conf's authorization{} block with identical publish +
 *      subscribe ACLs (generator fidelity).
 *   3. nats.conf's GENERATED block contains ZERO password fields and ZERO
 *      $NATS_*_USER/_PASS substitutions (cert-is-identity).
 *   4. generate-internal-certs.sh derives its CN list FROM services.yaml
 *      (mechanism pin — the two can no longer drift by construction).
 *   5. PUBLISH COVERAGE: every domain event type a service's code can build
 *      (createBaseEvent / eventType literals under apps/<svc>/src) is
 *      covered by that service's publish grants. This is the drift class
 *      that silently denied EVERY auth-service domain event at the broker
 *      (ORPHAN-HIGH-317).
 *   6. RPC COVERAGE: every @MessagePattern/@EventPattern subject a service
 *      handles is covered by its subscribe grants, and every NATS
 *      ClientProxy send/emit subject a service issues is covered by its
 *      publish grants. This is the drift class that killed
 *      `request.billing.tenant.provisionSubscription` (tenant provisioning),
 *      `request.messaging.getMessageForBroadcast` (WS broadcast) and
 *      `sensor.lookup.by-topic` (sidecar cache-miss) — all observed as LIVE
 *      Permissions Violations in production on 2026-07-02.
 *   7. SUBJECT SHAPE: @EventPattern subjects in the events.* space are
 *      3-segment (`events.*.{EventType}`) — a 2-segment subscriber can never
 *      match the 3-segment publisher shape (ORPHAN-013 drift class).
 *
 * # When it fails
 *
 *   - Hand-edit of nats.conf inside the BEGIN/END GENERATED sentinels →
 *     regenerate via `scripts/nats/generate-nats-conf.py`.
 *   - Added a service or changed grants in services.yaml without
 *     regenerating nats.conf → run the generator, commit the diff.
 *   - Added a `createBaseEvent('NewEvent', ...)` publish to a service
 *     without granting `events.*.NewEvent` in services.yaml → add the
 *     grant + regenerate (one commit, per ADR-015).
 *   - Added a @MessagePattern RPC handler without a subscribe grant, or a
 *     ClientProxy call without a publish grant → add the grant.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import {
  CONFIG_RUNTIME_INBOX_PREFIX,
  CONFIG_RUNTIME_NONSECRET_ALLOWLIST,
  CONFIG_RUNTIME_SECRET_ALLOWLIST,
  CONFIG_RUNTIME_SUBJECTS,
  MARINE_PROVIDER_CREDENTIAL_ALLOWLIST,
  MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET,
  TENANT_ERASURE_OUTCOME_KINDS,
  TENANT_ERASURE_TARGET_SERVICES,
  tenantErasureOutcomeSubject,
} from '@platform/event-contracts';
import Ajv from 'ajv';
import { parse as yamlParse } from 'yaml';

// Faz C (ARCH-HIGH-001 / ARCH-MEDIUM-004): the config-runtime caller allowlists +
// scoped-inbox token are the SSoT the config-service handler enforces; importing
// them here binds the NATS ACL grants to that same SSoT (the generic RPC scan
// cannot reach these — the send-site lives in libs/backend-common, and the
// config.runtime.* namespace is outside the scanned prefix set).

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The `yaml` package ships its own type declarations (js-yaml does not, and
// e2e is not an npm workspace so its @types never hoist). A typed
// `(input: string) => unknown` binding keeps the parse result `unknown` so
// every caller must narrow it with an explicit assertion instead of letting
// `any` flow through the invariant assertions below.
const parseYaml: (input: string) => unknown = yamlParse;

interface Service {
  name: string;
  application: string;
  description: string;
  publish: string[];
  subscribe: string[];
}

interface ServicesYaml {
  version: number;
  services: Service[];
}

interface HelmNatsIdentityRegistry {
  version: number;
  identities: string[];
}

type ComposeVolume = string | { source?: string; target?: string; read_only?: boolean };

interface ComposeService {
  environment?: Record<string, string | number | boolean | null>;
  volumes?: ComposeVolume[];
}

interface ComposeDocument {
  services: Record<string, ComposeService>;
}

function loadServicesYaml(): ServicesYaml {
  const path = join(REPO_ROOT, 'infrastructure', 'nats', 'services.yaml');
  return parseYaml(readFileSync(path, 'utf-8')) as ServicesYaml;
}

function loadServicesSchema(): object {
  const path = join(REPO_ROOT, 'infrastructure', 'nats', 'services.schema.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  return parsed as object;
}

function loadHelmNatsIdentityRegistry(): HelmNatsIdentityRegistry {
  const path = join(
    REPO_ROOT,
    'infrastructure',
    'helm',
    'aquaculture',
    'files',
    'nats-service-identities.yaml',
  );
  return parseYaml(readFileSync(path, 'utf-8')) as HelmNatsIdentityRegistry;
}

function loadComposeDocument(relativePath: string): ComposeDocument {
  const path = join(REPO_ROOT, relativePath);
  // Compose environment anchors use YAML merge keys. Resolving them here is
  // essential: the identity asserted below is the effective runtime value,
  // not merely a nearby comment or anchor name.
  return yamlParse(readFileSync(path, 'utf-8'), { merge: true }) as ComposeDocument;
}

function composeVolumeSource(volume: ComposeVolume): string {
  if (typeof volume === 'string') {
    return volume.split(':', 1)[0];
  }
  return volume.source ?? '';
}

function loadNatsConfAuthBlock(): string {
  const path = join(REPO_ROOT, 'infrastructure', 'docker', 'nats', 'nats.conf');
  const content = readFileSync(path, 'utf-8');
  const begin = content.indexOf('# BEGIN GENERATED');
  const end = content.indexOf('# END GENERATED');
  if (begin < 0 || end < 0) {
    throw new Error(
      'nats.conf is missing BEGIN/END GENERATED sentinels. Run ' +
        '`scripts/nats/generate-nats-conf.py` to regenerate.',
    );
  }
  return content.substring(begin, end);
}

/**
 * Parse a single NATS user entry out of the authorization block.
 *
 * The generator emits deterministic formatting — exactly one
 * `user: "CN=<name>",` per entry (verify_and_map maps the client cert DN
 * `CN=<name>` to the user), followed by `publish:` and `subscribe:` allow
 * arrays. We do string-based extraction (not full HOCON parsing) because
 * the generator is the only writer; hand-edits fail other invariants
 * before reaching this parser.
 */
interface NatsUserEntry {
  name: string;
  publish: string[];
  subscribe: string[];
}

function parseAuthBlockUsers(authBlock: string): NatsUserEntry[] {
  const users: NatsUserEntry[] = [];
  const entryRegex =
    /user:\s*"CN=([A-Za-z0-9_-]+)",\s*[\s\S]*?allow:\s*\[([^\]]*)\][\s\S]*?allow:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(authBlock)) !== null) {
    const [, name, publishRaw, subscribeRaw] = m;
    const parseAllow = (raw: string): string[] =>
      raw
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s.length > 0);
    users.push({
      name: name,
      publish: parseAllow(publishRaw),
      subscribe: parseAllow(subscribeRaw),
    });
  }
  return users;
}

/**
 * NATS subject match: token-wise, `*` matches exactly one token, `>` matches
 * one-or-more trailing tokens. Mirrors server-side semantics — the same
 * rules the broker applies to permission allow-lists.
 */
function natsMatch(subject: string, pattern: string): boolean {
  const s = subject.split('.');
  const p = pattern.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length >= i + 1;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return s.length === p.length;
}

function isCovered(subject: string, grants: string[]): boolean {
  return grants.some((g) => natsMatch(subject, g));
}

/**
 * Walk apps/<app>/src collecting production .ts sources (tests, archives and
 * node_modules excluded — test fixtures legitimately build synthetic events).
 */
function walkAppSources(appDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === '.archive') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (
        entry.endsWith('.ts') &&
        !entry.endsWith('.spec.ts') &&
        !entry.endsWith('.test.ts')
      ) {
        files.push(full);
      }
    }
  };
  walk(appDir);
  return files;
}

/**
 * Extract the PascalCase domain event types an app can build. Two shapes,
 * both anchored to production idioms:
 *   - `createBaseEvent('EventType', ...)` / `createBaseEvent<T>('EventType', ...)`
 *   - `eventType: 'EventType'` object-literal fields (outbox rows, event
 *     objects built without the factory)
 * PascalCase-only: lowercase literals (e.g. the migration sink's internal
 * 'applied'/'skipped' phase switch) are subject suffixes, not event types.
 */
function extractPublishedEventTypes(appDir: string): Set<string> {
  const types = new Set<string>();
  for (const file of walkAppSources(appDir)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/createBaseEvent(?:<[^>]*>)?\(\s*'([A-Z][A-Za-z0-9]+)'/g)) {
      types.add(m[1]);
    }
    for (const m of text.matchAll(/eventType:\s*'([A-Z][A-Za-z0-9]+)'/g)) {
      types.add(m[1]);
    }
  }
  return types;
}

/**
 * Resolve subject constants exported by @platform/event-contracts.
 * @MessagePattern call sites reference them as `IDENT.KEY`; the values are
 * plain string literals in these files, so a targeted regex is sufficient
 * (the constants are `as const` string maps, no computation involved).
 */
function loadContractSubjectConstants(): Map<string, string> {
  const constants = new Map<string, string>();
  const contractFiles = [
    'billing-admin-commands.ts',
    'notification-commands.ts',
    'tenant-commands.ts',
    'websocket-envelopes.ts',
    'auth-admin-commands.ts',
    'auth-user-queries.ts',
  ];
  for (const file of contractFiles) {
    const path = join(REPO_ROOT, 'libs', 'event-contracts', 'src', file);
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue; // contract file split/renamed — literals still covered below
    }
    // KEY: 'subject.with.dots'  (object members)
    for (const m of text.matchAll(
      /([A-Z][A-Z0-9_]+):\s*'((?:request|commands|events|sensor|st|policy)\.[^']+)'/g,
    )) {
      constants.set(m[1], m[2]);
    }
    // export const SOME_SUBJECT = 'subject.with.dots'
    for (const m of text.matchAll(
      /export const ([A-Z][A-Z0-9_]+)\s*=\s*'((?:request|commands|events|sensor|st|policy)\.[^']+)'/g,
    )) {
      constants.set(m[1], m[2]);
    }
  }
  return constants;
}

// `sensor.lookup.` (not bare `sensor.`) — sensor-service uses EventEmitter2
// with `sensor.<verb>` names for IN-PROCESS events; only the lookup RPC
// rides NATS. A bare `sensor.` prefix would flag every eventEmitter.emit().
const NATS_SUBJECT_PREFIXES = /^(request|commands|events|sensor\.lookup|st|policy)\./;

/**
 * Event types built by an app but NEVER published to NATS — persisted or
 * carried on a non-events.* subject. Every entry must say WHY. Anything not
 * listed here that the app can build MUST have a publish grant.
 */
const NON_NATS_EVENT_TYPES: Record<string, Record<string, string>> = {
  'event-store-service': {
    StreamDeleted: 'persisted into the event store; no NATS connection exists',
  },
  'admin-api-service': {
    IngestBackendPolicyChanged:
      'carried on exact policy.ingest_backend.changed (ADR-027/031), not an events.* subject',
    TenantSchemaDeletionFailed:
      'persisted in admin.tenant_erasure_operations.failures; no NATS event is published',
  },
};

interface RpcUsage {
  handled: Set<string>; // @MessagePattern / @EventPattern → needs SUBSCRIBE grant
  sent: Set<string>; // ClientProxy send/emit → needs PUBLISH grant
}

function extractRpcUsage(appDir: string, constants: Map<string, string>): RpcUsage {
  const handled = new Set<string>();
  const sent = new Set<string>();
  const resolveRef = (ref: string): string | undefined => {
    const literal = /^'([^']+)'$/.exec(ref);
    if (literal) return literal[1];
    const constRef =
      /^[A-Za-z0-9_$]+\.([A-Z][A-Z0-9_]+)$/.exec(ref) ?? /^([A-Z][A-Z0-9_]+)$/.exec(ref);
    if (constRef) return constants.get(constRef[1]);
    return undefined;
  };
  for (const file of walkAppSources(appDir)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/@(?:MessagePattern|EventPattern)\(\s*([^),]+)/g)) {
      const subject = resolveRef(m[1].trim());
      if (subject && NATS_SUBJECT_PREFIXES.test(subject)) handled.add(subject);
    }
    // ClientProxy `.send(subject, ...)` / `.emit(subject, ...)` — generic
    // param optional. Prefix filter drops non-NATS senders (mailers etc.).
    for (const m of text.matchAll(/\.(?:send|emit)(?:<[^>]*>)?\(\s*([^),]+)/g)) {
      const subject = resolveRef(m[1].trim());
      if (subject && NATS_SUBJECT_PREFIXES.test(subject)) sent.add(subject);
    }
  }
  return { handled, sent };
}

/**
 * apps/<dir> → services.yaml identity. The mapping is derived from the SSoT
 * `application` field so a runtime can never silently share another runtime's
 * certificate. db-migrate is the only explicit non-NATS application.
 */
const APP_TO_SERVICE: Record<string, string | null> = {
  ...Object.fromEntries(
    loadServicesYaml().services.map((service) => [service.application, service.name]),
  ),
  'db-migrate': null,
};

describe('NATS SSoT Invariants (ADR-015 cert-is-identity + ORPHAN-HIGH-317 subject scheme)', () => {
  const servicesDoc = loadServicesYaml();
  const authBlock = loadNatsConfAuthBlock();
  const parsedUsers = parseAuthBlockUsers(authBlock);
  const serviceByName = new Map(servicesDoc.services.map((s) => [s.name, s]));

  it('services.yaml is valid against services.schema.json', () => {
    const schema = loadServicesSchema();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(servicesDoc);
    if (!valid) {
      throw new Error(`services.yaml schema violations: ${JSON.stringify(validate.errors)}`);
    }
  });

  it('maps every NATS identity to exactly one runtime application', () => {
    const applications = servicesDoc.services.map((service) => service.application);
    expect(new Set(applications).size).toBe(applications.length);
    for (const service of servicesDoc.services) {
      expect(APP_TO_SERVICE[service.application]).toBe(service.name);
    }
    expect(APP_TO_SERVICE['admin-api-service']).toBe('admin_api_service');
    expect(APP_TO_SERVICE['gateway-api']).toBe('gateway_service');
    expect(APP_TO_SERVICE['admin-api-service']).not.toBe(APP_TO_SERVICE['gateway-api']);
  });

  it.each(['docker-compose.droplet.yml', 'docker-compose.prod.yml'])(
    '%s exposes exactly one certificate identity to every NATS application',
    (composePath) => {
      const compose = loadComposeDocument(composePath);
      const identityByApplication = new Map(
        servicesDoc.services.map((service) => [service.application, service.name]),
      );

      for (const [application, service] of Object.entries(compose.services)) {
        const expectedIdentity = identityByApplication.get(application);
        const configuredCert = service.environment?.NATS_TLS_CERT;
        if (!expectedIdentity) {
          if (configuredCert !== undefined) {
            throw new Error(
              `${composePath}:${application} configures NATS but has no application identity in services.yaml`,
            );
          }
          continue;
        }
        if (typeof configuredCert !== 'string') {
          throw new Error(
            `${composePath}:${application} is a NATS application but has no NATS_TLS_CERT`,
          );
        }
        const configuredKey = service.environment?.NATS_TLS_KEY;
        if (typeof configuredKey !== 'string') {
          throw new Error(
            `${composePath}:${application} is a NATS application but has no NATS_TLS_KEY`,
          );
        }

        expect(configuredCert).toContain(`/${expectedIdentity}-cert.pem`);
        expect(configuredKey).toContain(`/${expectedIdentity}-key.pem`);

        const natsSources = (service.volumes ?? [])
          .map(composeVolumeSource)
          .filter((source) => source.startsWith('./certs/nats'))
          .sort();
        expect(natsSources).toEqual(
          [
            './certs/nats/ca-cert.pem',
            `./certs/nats/clients/${expectedIdentity}-cert.pem`,
            `./certs/nats/clients/${expectedIdentity}-key.pem`,
          ].sort(),
        );
      }
    },
  );

  it('legacy AQUACULTURE_EVENTS subject grants are banned (stream name ≠ subject prefix)', () => {
    // The schema already rejects the prefix structurally; this assertion
    // exists for the error message (and covers the generated conf, which
    // the schema does not see).
    const offenders: string[] = [];
    for (const svc of servicesDoc.services) {
      for (const s of [...svc.publish, ...svc.subscribe]) {
        if (s.startsWith('AQUACULTURE_EVENTS.')) offenders.push(`${svc.name}: ${s}`);
      }
    }
    if (authBlock.includes('AQUACULTURE_EVENTS.')) offenders.push('nats.conf GENERATED block');
    if (offenders.length > 0) {
      throw new Error(
        `Legacy AQUACULTURE_EVENTS.* subject grants found:\n  ${offenders.join('\n  ')}\n` +
          'AQUACULTURE_EVENTS is the JetStream STREAM NAME — the event bus publishes to ' +
          'events.{tenantId|system}.{EventType}. A grant in the legacy scheme is dead ' +
          'weight that silently denies the real publish (ORPHAN-HIGH-317).',
      );
    }
  });

  it('services.yaml → nats.conf user count matches', () => {
    if (parsedUsers.length !== servicesDoc.services.length) {
      throw new Error(
        `Expected ${servicesDoc.services.length} user entries in nats.conf ` +
          `authorization block, got ${parsedUsers.length}. Run ` +
          `\`scripts/nats/generate-nats-conf.py\` to regenerate.`,
      );
    }
  });

  it.each((() => loadServicesYaml().services.map((s) => [s.name, s] as [string, Service]))())(
    'service %s has a matching nats.conf user entry with identical ACLs',
    (name, svc) => {
      const matched = parsedUsers.find((u) => u.name === name);
      if (!matched) {
        throw new Error(
          `services.yaml declares service "${name}" but nats.conf has no ` +
            `\`user: "CN=${name}"\` entry. Run the generator.`,
        );
      }
      if (matched.publish.join('|') !== svc.publish.join('|')) {
        throw new Error(
          `publish ACL drift for "${name}":\n` +
            `  yaml:     ${svc.publish.join(', ')}\n` +
            `  nats.conf: ${matched.publish.join(', ')}`,
        );
      }
      if (matched.subscribe.join('|') !== svc.subscribe.join('|')) {
        throw new Error(
          `subscribe ACL drift for "${name}":\n` +
            `  yaml:     ${svc.subscribe.join(', ')}\n` +
            `  nats.conf: ${matched.subscribe.join(', ')}`,
        );
      }
    },
  );

  it('nats.conf GENERATED block contains ZERO password fields', () => {
    if (/password:/i.test(authBlock)) {
      throw new Error(
        'nats.conf GENERATED authorization block contains a `password:` ' +
          'field. Under mTLS verify_and_map (ADR-015), passwords are ' +
          'redundant (server ignores CONNECT-frame auth) and a drift ' +
          'vector. Regenerate nats.conf via `scripts/nats/generate-nats-conf.py`.',
      );
    }
  });

  it('nats.conf GENERATED block contains ZERO $-interpolated user vars', () => {
    // Literal user names only — no `$NATS_*_USER` / `$NATS_*_PASS`.
    if (/\$NATS_[A-Z]+_(USER|PASS)/.test(authBlock)) {
      throw new Error(
        'nats.conf GENERATED authorization block still contains ' +
          '$NATS_*_USER or $NATS_*_PASS substitutions. Pre-ADR-015 ' +
          'pattern; regenerate via `scripts/nats/generate-nats-conf.py`.',
      );
    }
  });

  it('generate-internal-certs.sh derives its CN list from services.yaml (mechanism pin)', () => {
    const path = join(
      REPO_ROOT,
      'infrastructure',
      'docker',
      'scripts',
      'generate-internal-certs.sh',
    );
    const script = readFileSync(path, 'utf-8');
    // The cert script extracts CNs FROM services.yaml at runtime — the two
    // artifacts cannot drift by construction. Pin the mechanism: the script
    // must reference services.yaml and iterate the derived name list.
    if (!script.includes('services.yaml')) {
      throw new Error(
        'generate-internal-certs.sh no longer references services.yaml — ' +
          'the cert CN list must be DERIVED from the SSoT, not hand-maintained ' +
          '(ADR-015). If the derivation moved, update this invariant in lockstep.',
      );
    }
    if (!/while IFS= read -r svc/.test(script)) {
      throw new Error(
        'generate-internal-certs.sh no longer safely iterates $SERVICE_NAMES (the ' +
          'list derived from services.yaml). If the loop was renamed, update ' +
          'this invariant in lockstep.',
      );
    }
    expect(script).not.toContain('generate_client_cert');
    expect(script).not.toContain('aqua-services');
  });

  it('Helm issues one Secret per identity and mounts exactly one into each NATS runtime', () => {
    const registry = loadHelmNatsIdentityRegistry();
    expect(registry.version).toBe(1);
    expect(registry.identities).toEqual(servicesDoc.services.map((service) => service.name));

    const certificates = readFileSync(
      join(
        REPO_ROOT,
        'infrastructure',
        'helm',
        'aquaculture',
        'templates',
        'internal-certificates.yaml',
      ),
      'utf-8',
    );
    const helpers = readFileSync(
      join(REPO_ROOT, 'infrastructure', 'helm', 'aquaculture', 'templates', '_helpers.tpl'),
      'utf-8',
    );
    const templatesDir = join(REPO_ROOT, 'infrastructure', 'helm', 'aquaculture', 'templates');
    const renderedTemplates = readdirSync(templatesDir)
      .filter((file) => file.endsWith('.yaml'))
      .map((file) => readFileSync(join(templatesDir, file), 'utf-8'))
      .join('\n');
    const envIdentities = [
      ...renderedTemplates.matchAll(/natsServiceEnv"\s+\(list \. "([A-Za-z0-9_-]+)"\)/g),
    ].map((match) => match[1]);
    const volumeIdentities = [
      ...renderedTemplates.matchAll(/natsServiceVolume"\s+\(list \. "([A-Za-z0-9_-]+)"\)/g),
    ].map((match) => match[1]);
    const volumeMountCount = [
      ...renderedTemplates.matchAll(/include "aquaculture\.natsServiceVolumeMount"/g),
    ].length;

    expect(certificates).toContain('.Files.Get "files/nats-service-identities.yaml"');
    expect(certificates).toContain('commonName: {{ $identity | quote }}');
    expect(certificates).not.toContain('commonName: aqua-services');
    expect(helpers).toContain('aquaculture.natsClientSecretName');
    expect(helpers).toContain('/etc/ssl/nats-client/tls.crt');
    expect([...volumeIdentities].sort()).toEqual([...envIdentities].sort());
    expect(volumeMountCount).toBe(envIdentities.length);
    for (const identity of envIdentities) {
      expect(registry.identities).toContain(identity);
    }
  });

  describe('publish coverage — every code-buildable event type has a grant (ORPHAN-HIGH-317)', () => {
    const appsDir = join(REPO_ROOT, 'apps');
    const appDirs = readdirSync(appsDir).filter((d) => statSync(join(appsDir, d)).isDirectory());

    it('every apps/ directory has an explicit APP_TO_SERVICE mapping', () => {
      const unmapped = appDirs.filter(
        (d) => !(d in APP_TO_SERVICE) && statSync(join(appsDir, d)).isDirectory(),
      );
      if (unmapped.length > 0) {
        throw new Error(
          `apps/ directories missing from APP_TO_SERVICE: ${unmapped.join(', ')}. ` +
            'Map each to its services.yaml identity (or null for services with ' +
            'no NATS connection) so publish-coverage stays exhaustive.',
        );
      }
    });

    const mappedApps = appDirs
      .filter((d) => APP_TO_SERVICE[d] !== undefined)
      .map((d) => [d, APP_TO_SERVICE[d]] as [string, string | null]);

    it.each(mappedApps)('%s event types are covered by %s publish grants', (app, serviceName) => {
      const srcDir = join(appsDir, app, 'src');
      let types: Set<string>;
      try {
        statSync(srcDir);
        types = extractPublishedEventTypes(srcDir);
      } catch {
        return; // no src dir (e.g. pure-Rust app) — nothing to cover
      }
      for (const excluded of Object.keys(NON_NATS_EVENT_TYPES[app] ?? {})) {
        types.delete(excluded);
      }
      if (serviceName === null) {
        if (types.size > 0) {
          throw new Error(
            `apps/${app} has NO NATS identity in services.yaml but builds ` +
              `event types: ${[...types].sort().join(', ')}. Either these are ` +
              'persisted-only (document via an explicit allowlist here) or the ' +
              'service needs onboarding per docs/runbooks/nats-service-addition.md.',
          );
        }
        return;
      }
      const svc = serviceByName.get(serviceName);
      if (!svc) throw new Error(`APP_TO_SERVICE maps ${app} → unknown service ${serviceName}`);
      const missing = [...types]
        .sort()
        .filter(
          (t) =>
            !isCovered(`events.system.${t}`, svc.publish) ||
            !isCovered(`events.11111111-1111-1111-1111-111111111111.${t}`, svc.publish),
        );
      if (missing.length > 0) {
        throw new Error(
          `apps/${app} can build event types with NO publish grant for ` +
            `"${serviceName}" in services.yaml:\n  ${missing.join('\n  ')}\n` +
            `Add \`events.*.<Type>\` grants and regenerate nats.conf ` +
            '(scripts/nats/generate-nats-conf.py) in the same commit. Without ' +
            'the grant the broker refuses the publish with Permissions Violation ' +
            'and the event is silently lost (ORPHAN-HIGH-317).',
        );
      }
    });
  });

  describe('certificate-bound tenant-erasure outcome ACLs', () => {
    const legacyOutcomeSubjects = [
      'events.system.TenantDataErased',
      'events.system.TenantDataErasureFailed',
      'events.system.TenantErasureBlocked',
    ];
    const allOutcomeSubjects = TENANT_ERASURE_TARGET_SERVICES.flatMap((targetService) =>
      TENANT_ERASURE_OUTCOME_KINDS.map((outcome) =>
        tenantErasureOutcomeSubject(targetService, outcome),
      ),
    );

    it('defines exactly 36 globally unique certificate-bound outcome subjects', () => {
      expect(allOutcomeSubjects).toHaveLength(TENANT_ERASURE_TARGET_SERVICES.length * 3);
      expect(new Set(allOutcomeSubjects).size).toBe(allOutcomeSubjects.length);
    });

    it('denies all legacy generic outcome subjects to every certificate identity', () => {
      for (const service of servicesDoc.services) {
        for (const subject of legacyOutcomeSubjects) {
          expect(isCovered(subject, service.publish)).toBe(false);
        }
      }
    });

    it.each(TENANT_ERASURE_TARGET_SERVICES)(
      '%s certificate grants exactly its own three outcome types',
      (targetService) => {
        const identity = APP_TO_SERVICE[targetService];
        if (!identity) throw new Error(`No NATS identity for erasure target ${targetService}`);
        const service = serviceByName.get(identity);
        if (!service) throw new Error(`Unknown NATS identity ${identity}`);

        const expected = TENANT_ERASURE_OUTCOME_KINDS.map((outcome) =>
          tenantErasureOutcomeSubject(targetService, outcome),
        );
        const grantedOutcomeSubjects = allOutcomeSubjects.filter((subject) =>
          isCovered(subject.replace('events.*.', 'events.system.'), service.publish),
        );
        expect(grantedOutcomeSubjects).toEqual(expected);
      },
    );

    it('non-target certificates receive no tenant-erasure outcome grant', () => {
      const targetIdentities = new Set(
        TENANT_ERASURE_TARGET_SERVICES.map((target) => APP_TO_SERVICE[target]),
      );
      for (const service of servicesDoc.services) {
        if (targetIdentities.has(service.name)) continue;
        const granted = allOutcomeSubjects.filter((subject) =>
          isCovered(subject.replace('events.*.', 'events.system.'), service.publish),
        );
        expect(granted).toEqual([]);
      }
    });

    it('admin and gateway use distinct identities; gateway cannot publish admin proofs', () => {
      const admin = serviceByName.get('admin_api_service');
      const gateway = serviceByName.get('gateway_service');
      expect(admin).toBeDefined();
      expect(gateway).toBeDefined();
      expect(APP_TO_SERVICE['admin-api-service']).toBe('admin_api_service');
      expect(APP_TO_SERVICE['gateway-api']).toBe('gateway_service');
      for (const outcome of TENANT_ERASURE_OUTCOME_KINDS) {
        const pattern = TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET['admin-api-service'][outcome];
        const subject = `events.system.${pattern}`;
        expect(isCovered(subject, admin?.publish ?? [])).toBe(true);
        expect(isCovered(subject, gateway?.publish ?? [])).toBe(false);
      }
    });
  });

  describe('RPC coverage — handled patterns have subscribe grants, sent subjects have publish grants', () => {
    const appsDir = join(REPO_ROOT, 'apps');
    const constants = loadContractSubjectConstants();
    const appDirs = readdirSync(appsDir).filter(
      (d) => statSync(join(appsDir, d)).isDirectory() && APP_TO_SERVICE[d] !== undefined,
    );

    it.each(appDirs.map((d) => [d, APP_TO_SERVICE[d]] as [string, string | null]))(
      '%s RPC subjects are covered by %s grants',
      (app, serviceName) => {
        const srcDir = join(appsDir, app, 'src');
        let usage: RpcUsage;
        try {
          statSync(srcDir);
          usage = extractRpcUsage(srcDir, constants);
        } catch {
          return;
        }
        if (serviceName === null) {
          if (usage.handled.size > 0 || usage.sent.size > 0) {
            throw new Error(
              `apps/${app} has NO NATS identity but uses NATS RPC subjects: ` +
                `handled=[${[...usage.handled].join(', ')}] sent=[${[...usage.sent].join(', ')}]`,
            );
          }
          return;
        }
        const svc = serviceByName.get(serviceName);
        if (!svc) throw new Error(`APP_TO_SERVICE maps ${app} → unknown service ${serviceName}`);

        const missingSub = [...usage.handled].sort().filter((s) => !isCovered(s, svc.subscribe));
        const missingPub = [...usage.sent].sort().filter((s) => !isCovered(s, svc.publish));
        const problems: string[] = [];
        if (missingSub.length > 0) {
          problems.push(
            `handled patterns with NO subscribe grant:\n    ${missingSub.join('\n    ')}`,
          );
        }
        if (missingPub.length > 0) {
          problems.push(`sent subjects with NO publish grant:\n    ${missingPub.join('\n    ')}`);
        }
        if (problems.length > 0) {
          throw new Error(
            `apps/${app} ↔ services.yaml "${serviceName}" RPC grant drift:\n  ` +
              problems.join('\n  ') +
              '\nA missing subscribe grant means the handler NEVER receives the ' +
              'request (live class: request.billing.tenant.provisionSubscription); ' +
              'a missing publish grant means the caller times out.',
          );
        }

        // Shape check: @EventPattern subjects in events.* space must be
        // 3-segment — the publisher always emits events.{tenant|system}.{Type}
        // (ORPHAN-013: a 2-segment subscriber matches NOTHING, silently).
        const badShape = [...usage.handled].filter(
          (s) => s.startsWith('events.') && s.split('.').length !== 3,
        );
        if (badShape.length > 0) {
          throw new Error(
            `apps/${app} @EventPattern subjects with non-3-segment events shape: ` +
              `${badShape.join(', ')} — the canonical publish shape is ` +
              'events.{tenantId|system}.{EventType}; a different segment count ' +
              'never matches (NATS matching is segment-exact).',
          );
        }
      },
    );
  });

  describe('config-runtime secret-read grants (ARCH-HIGH-001 + ARCH-MEDIUM-004 + SEC-CRITICAL-001)', () => {
    // Representative subject under the scoped reply-inbox token — createInbox
    // appends `.<nuid>`, so any real reply subject is `_INBOXBILLINGCFG.<nuid>`.
    const scopedInboxSubject = `${CONFIG_RUNTIME_INBOX_PREFIX}.reply`;

    const requireService = (name: string): Service => {
      const svc = serviceByName.get(name);
      if (!svc) throw new Error(`services.yaml is missing the "${name}" service`);
      return svc;
    };

    it('billing_service PUBLISHES both config.runtime subjects; config_service SUBSCRIBES both (pinned)', () => {
      const billing = requireService('billing_service');
      const config = requireService('config_service');
      for (const subject of [CONFIG_RUNTIME_SUBJECTS.GET, CONFIG_RUNTIME_SUBJECTS.GET_SECRET]) {
        if (!isCovered(subject, billing.publish)) {
          throw new Error(`billing_service is missing the PUBLISH grant for "${subject}"`);
        }
        if (!isCovered(subject, config.subscribe)) {
          throw new Error(`config_service is missing the SUBSCRIBE grant for "${subject}"`);
        }
      }
    });

    it('the decrypted-secret reply inbox is scoped to billing↔config ONLY (SEC-CRITICAL-001)', () => {
      const billing = requireService('billing_service');
      const config = requireService('config_service');
      // billing subscribes the scoped inbox; config publishes replies to it.
      if (!isCovered(scopedInboxSubject, billing.subscribe)) {
        throw new Error(`billing_service is missing SUBSCRIBE for the scoped secret-reply inbox`);
      }
      if (!isCovered(scopedInboxSubject, config.publish)) {
        throw new Error(`config_service is missing PUBLISH for the scoped secret-reply inbox`);
      }
      // The broad `_INBOX.>` must NOT match the scoped token (first-token distinctness) —
      // this is the whole point: a `_INBOX.>` holder cannot read the secret reply.
      if (isCovered(scopedInboxSubject, ['_INBOX.>'])) {
        throw new Error(
          `${CONFIG_RUNTIME_INBOX_PREFIX} must be a DISTINCT first token from _INBOX so the ` +
            'platform-wide _INBOX.> grant cannot match the scoped secret-reply subject',
        );
      }
      // No OTHER service may grant the scoped inbox token, on publish or subscribe.
      for (const svc of servicesDoc.services) {
        if (svc.name === 'billing_service' || svc.name === 'config_service') continue;
        const leaks = [...svc.publish, ...svc.subscribe].filter(
          (g) => g.startsWith(CONFIG_RUNTIME_INBOX_PREFIX) || isCovered(scopedInboxSubject, [g]),
        );
        if (leaks.length > 0) {
          throw new Error(
            `${svc.name} must NOT hold any grant on the scoped secret-reply inbox ` +
              `(${CONFIG_RUNTIME_INBOX_PREFIX}) — it could passively read the plaintext ` +
              `Stripe secret. Offending grants: ${leaks.join(', ')}`,
          );
        }
      }
    });

    it('no service outside {billing,config} holds ANY config.runtime.* grant', () => {
      for (const svc of servicesDoc.services) {
        if (svc.name === 'billing_service' || svc.name === 'config_service') continue;
        const leaks = [...svc.publish, ...svc.subscribe].filter((g) =>
          g.startsWith('config.runtime.'),
        );
        if (leaks.length > 0) {
          throw new Error(
            `${svc.name} must NOT hold a config.runtime.* grant: ${leaks.join(', ')}`,
          );
        }
      }
    });

    it('every allowlisted caller holds the matching config.runtime.* PUBLISH grant (ARCH-MEDIUM-004)', () => {
      const check = (
        allowlist: Readonly<Record<string, readonly string[]>>,
        subject: string,
      ): void => {
        for (const caller of Object.keys(allowlist)) {
          const cn = APP_TO_SERVICE[caller];
          if (!cn) {
            throw new Error(
              `config-runtime allowlist caller "${caller}" has no APP_TO_SERVICE (cert-CN) mapping`,
            );
          }
          const svc = serviceByName.get(cn);
          if (!svc || !isCovered(subject, svc.publish)) {
            throw new Error(
              `config-runtime allowlist caller "${caller}" (CN "${cn}") lacks the PUBLISH ` +
                `grant for "${subject}" — the handler would authorize a caller the broker refuses.`,
            );
          }
        }
      };
      check(CONFIG_RUNTIME_SECRET_ALLOWLIST, CONFIG_RUNTIME_SUBJECTS.GET_SECRET);
      check(CONFIG_RUNTIME_NONSECRET_ALLOWLIST, CONFIG_RUNTIME_SUBJECTS.GET);
    });

    it('secret and non-secret allowlists are DISJOINT per caller (a secret key can never ride the GET path)', () => {
      for (const caller of Object.keys(CONFIG_RUNTIME_SECRET_ALLOWLIST)) {
        const secretKeys = new Set(CONFIG_RUNTIME_SECRET_ALLOWLIST[caller]);
        const nonSecretKeys = CONFIG_RUNTIME_NONSECRET_ALLOWLIST[caller] ?? [];
        const overlap = nonSecretKeys.filter((k) => secretKeys.has(k));
        if (overlap.length > 0) {
          throw new Error(
            `caller "${caller}" lists key(s) on BOTH the secret and non-secret allowlists ` +
              `(${overlap.join(', ')}) — the non-secret GET path would then be able to serve a secret`,
          );
        }
      }
    });
  });

  describe('marine provider credential grants (cert-is-identity + scoped reply isolation)', () => {
    const scopedInboxSubject = `${MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX}.reply`;

    const requireService = (name: string): Service => {
      const svc = serviceByName.get(name);
      if (!svc) throw new Error(`services.yaml is missing the "${name}" service`);
      return svc;
    };

    it('farm_service publishes exact credential RPCs and config_service subscribes them', () => {
      const farm = requireService('farm_service');
      const config = requireService('config_service');
      for (const subject of Object.values(MARINE_PROVIDER_CREDENTIAL_SUBJECTS)) {
        if (!isCovered(subject, farm.publish)) {
          throw new Error(`farm_service is missing the PUBLISH grant for "${subject}"`);
        }
        if (!isCovered(subject, config.subscribe)) {
          throw new Error(`config_service is missing the SUBSCRIBE grant for "${subject}"`);
        }
      }
    });

    it('keeps decrypted marine credential replies scoped to farm and config only', () => {
      const farm = requireService('farm_service');
      const config = requireService('config_service');
      if (!isCovered(scopedInboxSubject, farm.subscribe)) {
        throw new Error('farm_service is missing SUBSCRIBE for the marine credential reply inbox');
      }
      if (!isCovered(scopedInboxSubject, config.publish)) {
        throw new Error('config_service is missing PUBLISH for the marine credential reply inbox');
      }
      if (isCovered(scopedInboxSubject, ['_INBOX.>'])) {
        throw new Error(
          `${MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX} must remain a distinct first token from _INBOX`,
        );
      }
      for (const svc of servicesDoc.services) {
        if (svc.name === 'farm_service' || svc.name === 'config_service') continue;
        const leaks = [...svc.publish, ...svc.subscribe].filter(
          (grant) =>
            grant.startsWith(MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX) ||
            isCovered(scopedInboxSubject, [grant]),
        );
        if (leaks.length > 0) {
          throw new Error(
            `${svc.name} must not hold marine credential reply-inbox grants: ${leaks.join(', ')}`,
          );
        }
      }
    });

    it('binds the contract allowlist to farm_service and denies credential RPC grants elsewhere', () => {
      expect(Object.keys(MARINE_PROVIDER_CREDENTIAL_ALLOWLIST)).toEqual(['farm-service']);
      const farm = requireService('farm_service');
      for (const subject of Object.values(MARINE_PROVIDER_CREDENTIAL_SUBJECTS)) {
        expect(farm.publish).toContain(subject);
      }
      for (const svc of servicesDoc.services) {
        if (svc.name === 'farm_service' || svc.name === 'config_service') continue;
        const leaks = [...svc.publish, ...svc.subscribe].filter((grant) =>
          grant.startsWith('config.marine_credentials.'),
        );
        expect(leaks).toEqual([]);
      }
    });
  });
});
