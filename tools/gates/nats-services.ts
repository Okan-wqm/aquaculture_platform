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
 *   - the read: one YAML parse, then the shape the SSoT's own schema declares
 *     (infrastructure/nats/services.schema.json, draft-07). No hand-written shape check; a document
 *     the schema refuses throws NatsServicesInvalid. Beyond the schema, the integrity draft-07
 *     cannot say: one entry per identity and per application, no repeated grant, every grant a
 *     NATS subject (ARIA-LOW-603). The same parse keeps where each identity and grant is written
 *     (`parseNatsServicesLocated`), so a fact citing services.yaml cites its line (SE-3).
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
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';

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

/**
 * Why `subject` is not a NATS subject the broker accepts, or null. The schema's character class
 * admits an empty token (`a..b`), a partial wildcard (`foo*bar`) and an inner `>`. Exported for
 * readers of the GENERATED nats.conf (the messaging ACL smoke), so the grammar has one owner.
 */
export function natsSubjectGrammarError(subject: string): string | null {
  const tokens = subject.split('.');
  if (tokens.some((token) => token === '')) return `has an empty NATS subject token: ${subject}`;
  for (const [index, token] of tokens.entries()) {
    if ((token.includes('*') && token !== '*') || (token.includes('>') && token !== '>')) {
      return `has a partial NATS subject wildcard token: ${subject}`;
    }
    if (token === '>' && index !== tokens.length - 1) {
      return `has a NATS subject wildcard before the final token: ${subject}`;
    }
  }
  return null;
}

function repeated(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/**
 * What a valid document holds beyond what draft-07 can say (ARIA-LOW-603): one entry per
 * certificate identity and per application, no grant listed twice in one permission, and every
 * grant a NATS subject. The messaging ACL smoke checked these on a private parse; here every
 * consumer gets them.
 */
function integrityErrors(services: readonly NatsServiceEntry[]): string[] {
  const errors = [
    ...repeated(services.map((service) => service.name)).map((name) => `duplicate service ${name}`),
    ...repeated(services.map((service) => service.application)).map(
      (application) => `duplicate application ${application}`,
    ),
  ];
  for (const service of services) {
    for (const permission of ['publish', 'subscribe'] as const) {
      for (const grant of repeated(service[permission])) {
        errors.push(`${service.name}.${permission} repeats ${grant}`);
      }
      for (const grant of service[permission]) {
        const grammar = natsSubjectGrammarError(grant);
        if (grammar !== null) errors.push(`${service.name}.${permission} ${grammar}`);
      }
    }
  }
  return errors;
}

/** 1-based source lines of one entry: its identity (`name`) and each of its grants, in order. */
export interface NatsServiceSourceLines {
  readonly name: number;
  readonly publish: readonly number[];
  readonly subscribe: readonly number[];
}

export interface LocatedNatsServices {
  readonly services: readonly NatsServiceEntry[];
  /** Keyed by certificate identity (`name`), which the integrity rules keep unique. */
  readonly lines: ReadonlyMap<string, NatsServiceSourceLines>;
}

/** The 1-based line a scalar node starts on; the schema has already admitted the node's shape. */
function scalarLine(node: unknown, counter: LineCounter, at: string): number {
  if (!isScalar(node) || node.range === undefined || node.range === null) {
    throw new NatsServicesInvalid(`${at} is not a scalar with a source position`);
  }
  return counter.linePos(node.range[0]).line;
}

function grantLines(
  entry: YamlNode,
  key: 'publish' | 'subscribe',
  counter: LineCounter,
  at: string,
): number[] {
  const list = isMap(entry) ? entry.get(key, true) : undefined;
  if (!isSeq(list)) throw new NatsServicesInvalid(`${at}.${key} is not a list`);
  return list.items.map((item, index) => scalarLine(item, counter, `${at}.${key}[${index}]`));
}

/**
 * Parse services.yaml text and keep each identity's and grant's line; a document its schema
 * refuses, or one that breaks the integrity rules above, throws NatsServicesInvalid.
 */
export function parseNatsServicesLocated(source: string): LocatedNatsServices {
  const counter = new LineCounter();
  const parsed = parseDocument(source, { lineCounter: counter });
  const [syntaxError] = parsed.errors;
  if (syntaxError !== undefined) {
    // The parser's own message quotes the offending source lines; a reader such as the code-fact
    // bridge carries this message into a witness, so it names the error and its position only.
    const { line, col } = counter.linePos(syntaxError.pos[0]);
    throw new NatsServicesInvalid(`not YAML: ${syntaxError.code} at line ${line}, column ${col}`);
  }
  const document: unknown = parsed.toJS();
  if (!isValidDocument(document)) {
    const errors = (schemaValidator().errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    throw new NatsServicesInvalid(`does not match ${NATS_SERVICES_SCHEMA}: ${errors}`);
  }
  const integrity = integrityErrors(document.services);
  if (integrity.length > 0) throw new NatsServicesInvalid(integrity.join('; '));
  const entries = parsed.get('services', true);
  if (!isSeq(entries)) throw new NatsServicesInvalid('services is not a list');
  const lines = new Map<string, NatsServiceSourceLines>();
  document.services.forEach((service, index) => {
    const entry = entries.items[index];
    const at = `services[${index}]`;
    if (!isMap(entry)) throw new NatsServicesInvalid(`${at} is not a mapping`);
    lines.set(service.name, {
      name: scalarLine(entry.get('name', true), counter, `${at}.name`),
      publish: grantLines(entry, 'publish', counter, at),
      subscribe: grantLines(entry, 'subscribe', counter, at),
    });
  });
  return { services: document.services, lines };
}

/**
 * Parse services.yaml text; a document its schema refuses, or one that breaks the integrity rules
 * above, throws NatsServicesInvalid.
 */
export function parseNatsServices(source: string): readonly NatsServiceEntry[] {
  return parseNatsServicesLocated(source).services;
}

function readNatsServicesSource(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new NatsServicesInvalid(
      `unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read and parse services.yaml (this checkout's when no path is given). */
export function loadNatsServices(
  path: string = join(REPO_ROOT, NATS_SERVICES_YAML),
): readonly NatsServiceEntry[] {
  return parseNatsServices(readNatsServicesSource(path));
}

/** Read and parse services.yaml with the source line of every identity and grant. */
export function loadNatsServicesLocated(path: string): LocatedNatsServices {
  return parseNatsServicesLocated(readNatsServicesSource(path));
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
