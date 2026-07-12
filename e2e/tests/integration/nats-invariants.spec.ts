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

import Ajv from 'ajv';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The `yaml` package ships its own type declarations (js-yaml does not, and
// e2e is not an npm workspace so its @types never hoist). A typed
// `(input: string) => unknown` binding keeps the parse result `unknown` so
// every caller must narrow it with an explicit assertion instead of letting
// `any` flow through the invariant assertions below.
const parseYaml: (input: string) => unknown = yamlParse;

interface Service {
  name: string;
  description: string;
  publish: string[];
  subscribe: string[];
}

interface ServicesYaml {
  version: number;
  services: Service[];
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
    for (const m of text.matchAll(/([A-Z][A-Z0-9_]+):\s*'((?:request|commands|events|sensor|st|policy)\.[^']+)'/g)) {
      constants.set(m[1], m[2]);
    }
    // export const SOME_SUBJECT = 'subject.with.dots'
    for (const m of text.matchAll(/export const ([A-Z][A-Z0-9_]+)\s*=\s*'((?:request|commands|events|sensor|st|policy)\.[^']+)'/g)) {
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
      'carried on policy.ingest_backend.changed (ADR-027/031), covered by the policy.ingest_backend.> grant — not an events.* subject',
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
    const constRef = /^[A-Za-z0-9_$]+\.([A-Z][A-Z0-9_]+)$/.exec(ref) ?? /^([A-Z][A-Z0-9_]+)$/.exec(ref);
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
 * apps/<dir> → services.yaml identity. Services WITHOUT a NATS identity are
 * explicitly null (they must not gain silent NATS usage — the coverage test
 * fails if a null-mapped app starts building events or RPC handlers).
 *
 *   - admin-api-service shares the gateway_service account (documented in
 *     services.yaml — shared cert CN).
 *   - event-store-service, config-service and db-migrate have NO NATS
 *     connection today (verified 2026-07-02: no EventBusModule import, no
 *     NATS boot log lines). Onboarding one = services.yaml entry + cert CN
 *     + compose mount, per docs/runbooks/nats-service-addition.md.
 *   - sensor-ingestion is Rust — outside TS extraction; its grants are
 *     pinned by apps/sensor-ingestion/src/sensor_lookup.rs LOOKUP_SUBJECT
 *     and the events.*.SensorReading publish path (ADR-025).
 */
const APP_TO_SERVICE: Record<string, string | null> = {
  'admin-api-service': 'gateway_service',
  'ai-service': 'ai_service',
  'alert-engine': 'alert_engine',
  'auth-service': 'auth_service',
  'billing-service': 'billing_service',
  'config-service': 'config_service',
  'db-migrate': null,
  'event-store-service': null,
  'farm-service': 'farm_service',
  'gateway-api': 'gateway_service',
  'hr-service': 'hr_service',
  'hydroponics-service': 'hydroponics_service',
  'messaging-service': 'messaging_service',
  'notification-service': 'notification_service',
  'observability-service': 'observability_service',
  'sensor-ingestion': null, // Rust — no TS sources to extract
  'sensor-service': 'sensor_service',
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
    if (!/for svc in \$SERVICE_NAMES/.test(script)) {
      throw new Error(
        'generate-internal-certs.sh no longer iterates $SERVICE_NAMES (the ' +
          'list derived from services.yaml). If the loop was renamed, update ' +
          'this invariant in lockstep.',
      );
    }
  });

  describe('publish coverage — every code-buildable event type has a grant (ORPHAN-HIGH-317)', () => {
    const appsDir = join(REPO_ROOT, 'apps');
    const appDirs = readdirSync(appsDir).filter((d) =>
      statSync(join(appsDir, d)).isDirectory(),
    );

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

  describe('erasure-target proof-event publish coverage (systemic grant gap — 2026-07-11 Lane-D db-audit)', () => {
    // The per-service OutboxWorker publishes the TenantErasureTargetExecutor's
    // proof events (TenantDataErased/…Failed/…Blocked) under the target
    // service's OWN cert. Those event literals live in libs/backend-common (the
    // shared executor), NOT the app src — so the publish-coverage scan above
    // MISSES them, and every forService target except farm shipped with no
    // grant (the broker would reject the proof publish → the GDPR-erasure
    // cascade could never confirm completion). This guard closes that blind
    // spot by keying off the forService wiring instead of app-src literals.
    const appsDir = join(REPO_ROOT, 'apps');
    const PROOF_EVENTS = ['TenantDataErased', 'TenantDataErasureFailed', 'TenantErasureBlocked'];

    const wiresErasureTarget = (app: string): boolean => {
      const srcDir = join(appsDir, app, 'src');
      try {
        statSync(srcDir);
      } catch {
        return false;
      }
      const stack = [srcDir];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.endsWith('.ts')) continue;
          if (readFileSync(full, 'utf8').includes('TenantErasureTargetModule.forService')) {
            return true;
          }
        }
      }
      return false;
    };

    const targetApps = readdirSync(appsDir)
      .filter(
        (d) =>
          statSync(join(appsDir, d)).isDirectory() &&
          APP_TO_SERVICE[d] &&
          wiresErasureTarget(d),
      )
      .map((d) => [d, APP_TO_SERVICE[d]] as [string, string]);

    it('discovers at least one erasure-target app (regression guard)', () => {
      expect(targetApps.length).toBeGreaterThan(0);
    });

    it.each(targetApps)(
      '%s (%s) grants the 3 tenant-erasure proof events it publishes via its own outbox',
      (app, serviceName) => {
        const svc = serviceByName.get(serviceName);
        if (!svc) throw new Error(`APP_TO_SERVICE maps ${app} → unknown service ${serviceName}`);
        const missing = PROOF_EVENTS.filter(
          (e) => !isCovered(`events.system.${e}`, svc.publish),
        );
        if (missing.length > 0) {
          throw new Error(
            `apps/${app} wires TenantErasureTargetModule.forService but "${serviceName}" ` +
              `lacks publish grants for the proof events its OWN outbox worker emits: ` +
              `${missing.map((e) => `events.*.${e}`).join(', ')}. The publish-coverage scan ` +
              'misses these (the literal lives in libs/backend-common, not the app src). ' +
              'Add the grants + regenerate nats.conf, else the broker refuses the proof ' +
              'publish (Permissions Violation) and the GDPR-erasure cascade cannot confirm ' +
              'completion for this service.',
          );
        }
      },
    );
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
          problems.push(
            `sent subjects with NO publish grant:\n    ${missingPub.join('\n    ')}`,
          );
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
});
