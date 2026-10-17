/**
 * nats-services — the one reader of infrastructure/nats/services.yaml for tools (ARIA-MEDIUM-314).
 * ===============================================================================================
 *
 * services.yaml is the NATS ACL SSoT (ADR-015): per service, its certificate identity (`name`), the
 * nx project / apps directory it belongs to (`application`) and the subjects it may publish and
 * subscribe. Tools used to read it with private copies of a parser, a subject matcher and a subject
 * rule. When the SSoT dropped its list-item quotes (2026-08-01) and its grants left the
 * `AQUACULTURE_EVENTS.<T>.>` namespace (2026-07-02), the copy in tools/ripple-tracer/cli.ts kept the
 * old grammar and reported no producer and no subscriber for any event, while the plan-coverage
 * witness had been repaired separately (ARIA-HIGH-306). One reader means a format change reaches
 * every tool at once.
 *
 * What this module owns:
 *   - the read: `yaml.parse`, then the shape the SSoT's own schema declares
 *     (infrastructure/nats/services.schema.json, draft-07). No hand-written shape check; a document
 *     the schema refuses throws NatsServicesInvalid.
 *   - NATS subject semantics: `subjectMatches` (one filter against one concrete subject) and
 *     `filtersOverlap` (do two filters share a subject). `*` is exactly one whole token, `>` is the
 *     last token and matches one or more, every other token is literal, and an empty token matches
 *     nothing (the broker refuses such subjects).
 *   - the subjects an event type travels on (`eventSubjectsFor`) and the ACL ripple of an event
 *     (`aclEventRipple`): who may publish it and whose subscribe grants admit it.
 *
 * Independent oracles keep their own matcher on purpose, because they judge broker semantics and
 * must not depend on the code they judge: e2e/tests/integration/nats-invariants.spec.ts and
 * e2e/tests/integration/nats-subject-contract.spec.ts.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Ajv, { type ValidateFunction } from 'ajv';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Repo-relative path of the SSoT; callers with their own repo root join it themselves. */
export const NATS_SERVICES_YAML = join('infrastructure', 'nats', 'services.yaml');
/** The SSoT's shape, owned by the schema next to it. */
export const NATS_SERVICES_SCHEMA = join('infrastructure', 'nats', 'services.schema.json');

export interface NatsServiceEntry {
  /** Certificate identity (CN), e.g. `auth_service`. */
  readonly name: string;
  /** The nx project / apps directory that owns the identity, e.g. `auth-service`. */
  readonly application: string;
  readonly description: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

export class NatsServicesInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NatsServicesInvalid';
  }
}

let cachedValidator: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (cachedValidator === null) {
    // The schema travels with this module's checkout, never with a caller's --repo-root.
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, NATS_SERVICES_SCHEMA), 'utf8'),
    ) as object;
    cachedValidator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  return cachedValidator;
}

interface ValidDocument {
  readonly version: number;
  readonly services: readonly NatsServiceEntry[];
}

function isValidDocument(document: unknown): document is ValidDocument {
  return schemaValidator()(document) === true;
}

/** Parse services.yaml text; a document its schema refuses throws NatsServicesInvalid. */
export function parseNatsServices(source: string): readonly NatsServiceEntry[] {
  let document: unknown;
  try {
    document = yamlParse(source);
  } catch (error) {
    throw new NatsServicesInvalid(
      `not YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isValidDocument(document)) {
    const errors = (schemaValidator().errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    throw new NatsServicesInvalid(`does not match ${NATS_SERVICES_SCHEMA}: ${errors}`);
  }
  return document.services;
}

/** Read and parse services.yaml (this checkout's when no path is given). */
export function loadNatsServices(
  path: string = join(REPO_ROOT, NATS_SERVICES_YAML),
): readonly NatsServiceEntry[] {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new NatsServicesInvalid(
      `unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseNatsServices(source);
}

/** Does the filter `filter` admit the concrete subject `subject` (NATS semantics)? */
export function subjectMatches(filter: string, subject: string): boolean {
  const filterTokens = filter.split('.');
  const subjectTokens = subject.split('.');
  if (subjectTokens.some((token) => token === '') || filterTokens.some((token) => token === ''))
    return false;
  for (let index = 0; index < filterTokens.length; index += 1) {
    const expected = filterTokens[index];
    if (expected === '>') return index === filterTokens.length - 1 && subjectTokens.length > index;
    if (index >= subjectTokens.length) return false;
    if (expected !== '*' && expected !== subjectTokens[index]) return false;
  }
  return filterTokens.length === subjectTokens.length;
}

/** Do two filters admit at least one common concrete subject? */
export function filtersOverlap(left: string, right: string): boolean {
  const a = left.split('.');
  const b = right.split('.');
  if (a.some((token) => token === '') || b.some((token) => token === '')) return false;
  for (let index = 0; ; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined || y === undefined) return x === y;
    // `>` matches one or more tokens; the other side has at least this token.
    if (x === '>' || y === '>') return true;
    if (x !== '*' && y !== '*' && x !== y) return false;
  }
}

/**
 * The event bus's default subject root (platform/libs/event-bus/src/nats/event-route-registry.ts,
 * `subjectRootForEventType`). That owner also routes a few telemetry types (SensorReading,
 * SensorMetricIngested) to `telemetry`; it cannot be imported from tools (it needs the
 * @platform path aliases), so an event type no service declares falls back to `events` here.
 * Every declared type takes its subjects from the grants, so the fallback only applies to types
 * the SSoT does not grant at all.
 */
export const DEFAULT_EVENT_SUBJECT_ROOT = 'events';

export type SubjectSource = 'declared' | 'default_root';

/**
 * The subjects `eventType` travels on: every publish grant whose tokens include the event type
 * (`events.*.UserInvited`, `telemetry.*.SensorReading`), else the bus's default `events.*.<T>`.
 */
export function eventSubjectsFor(
  eventType: string,
  services: readonly NatsServiceEntry[],
): { readonly subjects: readonly string[]; readonly source: SubjectSource } {
  const declared = new Set<string>();
  for (const service of services) {
    for (const grant of service.publish) {
      if (grant.split('.').includes(eventType)) declared.add(grant);
    }
  }
  if (declared.size === 0) {
    return { subjects: [`${DEFAULT_EVENT_SUBJECT_ROOT}.*.${eventType}`], source: 'default_root' };
  }
  return { subjects: [...declared].sort(), source: 'declared' };
}

export interface GrantMatch {
  readonly service: NatsServiceEntry;
  /** The grant that admits the subject. */
  readonly grant: string;
  /** The event subject it admits. */
  readonly subject: string;
  /**
   * True when the grant admits the event only through wildcards, i.e. no literal token of the
   * grant is the event type (`events.>`): a permission to receive, not evidence of consumption.
   */
  readonly catchAll: boolean;
}

export interface AclRipple {
  readonly subjects: readonly string[];
  readonly producers: readonly GrantMatch[];
  readonly aclSubscribers: readonly GrantMatch[];
}

function firstMatch(
  service: NatsServiceEntry,
  grants: readonly string[],
  subjects: readonly string[],
  eventType: string,
): GrantMatch | null {
  // An explicit grant naming the event wins over a catch-all one on the same service.
  const matches: GrantMatch[] = [];
  for (const subject of subjects) {
    for (const grant of grants) {
      if (filtersOverlap(grant, subject)) {
        matches.push({ service, grant, subject, catchAll: !grant.split('.').includes(eventType) });
      }
    }
  }
  return matches.find((match) => !match.catchAll) ?? matches[0] ?? null;
}

/** Who may publish `eventType` on `subjects`, and whose subscribe grants admit it. */
export function aclEventRipple(
  eventType: string,
  services: readonly NatsServiceEntry[],
  subjects: readonly string[] = eventSubjectsFor(eventType, services).subjects,
): AclRipple {
  const producers: GrantMatch[] = [];
  const aclSubscribers: GrantMatch[] = [];
  for (const service of services) {
    const produced = firstMatch(service, service.publish, subjects, eventType);
    if (produced !== null) producers.push(produced);
    const subscribed = firstMatch(service, service.subscribe, subjects, eventType);
    if (subscribed !== null) aclSubscribers.push(subscribed);
  }
  return { subjects, producers, aclSubscribers };
}
