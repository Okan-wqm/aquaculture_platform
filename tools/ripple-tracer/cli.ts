#!/usr/bin/env ts-node
/**
 * ripple-tracer — CLI entry.
 *
 * Given an event type, answers "which services will be affected if this
 * event's contract changes?" by reading the ADR-015 cert-is-identity SSoT
 * (infrastructure/nats/services.yaml) and running NATS-spec-correct
 * subject matching across every service's subscribe list.
 *
 * Usage:
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType>
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType> --subject <subject-override>
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType> --format json
 *
 * Default output is a Markdown report suitable for pasting into an
 * implementation-planner package body or a data-expert review finding.
 * `--format json` emits a stable JSON shape for programmatic consumers.
 *
 * Exit codes (contract — test scripts depend on these):
 *   0 — success, ripple computed (may be empty).
 *   1 — event type not found in any producer's publish list (likely a
 *        non-NATS event or a typo).
 *   2 — usage error (missing / unknown flag).
 *   3 — services.yaml parse error.
 *
 * Single-file design on purpose: avoids ESM/CJS resolution fragility of
 * cross-file imports in ts-node + auto-detect mode. Helpers stay under
 * ~250 LOC total.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// services.yaml parser
// ---------------------------------------------------------------------------

interface ServiceEntry {
  readonly name: string;
  readonly description?: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

interface ServicesYaml {
  readonly version: number;
  readonly services: readonly ServiceEntry[];
}

/**
 * Narrow regex-based parser targeting the specific yaml shape in
 * infrastructure/nats/services.yaml. Covers:
 *   - `services:` flat list.
 *   - Per-service `- name: <name>` + optional `description:` + `publish:`
 *     + `subscribe:` string arrays.
 *   - List items `- "<string>"` with double quotes.
 *
 * Deliberately not a general YAML parser — the yaml file is the SSoT
 * for NATS ACL and its shape is enforced by the generator + invariant
 * tests. Broader YAML features (anchors, nested maps, multi-line
 * strings) would be noise here.
 */
function parseServicesYaml(source: string): ServicesYaml {
  const services: ServiceEntry[] = [];
  const lines = source.split('\n').map((l) => (l.includes('#') ? l.slice(0, l.indexOf('#')) : l));

  let current: {
    name: string;
    description?: string;
    publish: string[];
    subscribe: string[];
  } | null = null;
  let currentList: 'publish' | 'subscribe' | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.length === 0) continue;

    const serviceStart = /^\s*-\s+name:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (serviceStart?.[1]) {
      if (current) services.push(Object.freeze(current));
      current = { name: serviceStart[1], publish: [], subscribe: [] };
      currentList = null;
      continue;
    }

    if (!current) continue;

    const descLine = /^\s*description:\s*(.*)$/.exec(line);
    if (descLine?.[1]) {
      current.description = descLine[1].replace(/^["']|["']$/g, '').trim();
      currentList = null;
      continue;
    }

    if (/^\s*publish:\s*$/.test(line)) {
      currentList = 'publish';
      continue;
    }
    if (/^\s*subscribe:\s*$/.test(line)) {
      currentList = 'subscribe';
      continue;
    }

    const listItem = /^\s*-\s+["']([^"']+)["']\s*$/.exec(line);
    if (listItem?.[1] && currentList) {
      current[currentList].push(listItem[1]);
      continue;
    }
  }

  if (current) services.push(Object.freeze(current));
  return { version: 1, services: Object.freeze(services) };
}

// ---------------------------------------------------------------------------
// NATS subject matching
// ---------------------------------------------------------------------------

/**
 * NATS subject-matching rules (per the NATS server spec):
 *   - A subject is a dot-separated sequence of tokens.
 *   - `*` in a pattern matches exactly one token.
 *   - `>` in a pattern (must be last) matches one or more tokens.
 *   - Every other token matches only its literal.
 *
 * aqua-saas convention extension: `<Prefix>*` (literal prefix + star
 * suffix, e.g. `Farm*`) matches any token starting with that prefix.
 * The `scripts/nats/generate-nats-conf.py` preserves this form verbatim
 * in the NATS ACL and the server honours it; we mirror the behaviour.
 */
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');

  for (let i = 0; i < p.length; i++) {
    const pt = p[i];
    const st = s[i];
    if (pt === '>') return i < s.length && i === p.length - 1;
    if (st === undefined) return false;
    if (pt === '*') continue;
    if (pt && pt.endsWith('*')) {
      const prefix = pt.slice(0, -1);
      if (!st.startsWith(prefix)) return false;
      continue;
    }
    if (pt !== st) return false;
  }
  return s.length === p.length;
}

/**
 * Two-pattern overlap: does any concrete subject exist that both `a` and
 * `b` would match? Used when the producer publishes a wildcard and the
 * subscriber also subscribes to a wildcard — we need to know if the
 * sets intersect, not just whether one string matches the other.
 */
function patternsOverlap(a: string, b: string): boolean {
  const aWild = a.includes('*') || a.includes('>');
  const bWild = b.includes('*') || b.includes('>');
  if (!aWild) return subjectMatches(b, a);
  if (!bWild) return subjectMatches(a, b);

  const ta = a.split('.');
  const tb = b.split('.');
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === '>' || y === '>') return true;
    if (x === undefined || y === undefined) return false;
    if (x === '*' || y === '*') continue;
    if (x.endsWith('*') && y.endsWith('*')) {
      const px = x.slice(0, -1);
      const py = y.slice(0, -1);
      if (!px.startsWith(py) && !py.startsWith(px)) return false;
      continue;
    }
    if (x.endsWith('*')) {
      if (!y.startsWith(x.slice(0, -1))) return false;
      continue;
    }
    if (y.endsWith('*')) {
      if (!x.startsWith(y.slice(0, -1))) return false;
      continue;
    }
    if (x !== y) return false;
  }
  return ta.length === tb.length;
}

function defaultSubjectFor(eventType: string): string {
  return `AQUACULTURE_EVENTS.${eventType}.>`;
}

interface RippleSet {
  readonly eventType: string;
  readonly subject: string;
  readonly producers: readonly ServiceEntry[];
  readonly subscribers: readonly { service: ServiceEntry; matchingPattern: string }[];
}

function computeRipple(
  yaml: ServicesYaml,
  eventType: string,
  overrideSubject: string | undefined,
): RippleSet {
  const subject = overrideSubject ?? defaultSubjectFor(eventType);
  const producers: ServiceEntry[] = [];
  const subscribers: { service: ServiceEntry; matchingPattern: string }[] = [];

  for (const svc of yaml.services) {
    for (const pub of svc.publish) {
      if (patternsOverlap(pub, subject)) {
        producers.push(svc);
        break;
      }
    }
    for (const sub of svc.subscribe) {
      if (patternsOverlap(sub, subject)) {
        subscribers.push({ service: svc, matchingPattern: sub });
        break;
      }
    }
  }

  return {
    eventType,
    subject,
    producers: Object.freeze(producers),
    subscribers: Object.freeze(subscribers),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  event: string;
  subject?: string;
  format: 'markdown' | 'json';
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  let event: string | undefined;
  let subject: string | undefined;
  let format: 'markdown' | 'json' = 'markdown';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--event') {
      event = argv[++i];
      continue;
    }
    if (arg?.startsWith('--event=')) {
      event = arg.slice('--event='.length);
      continue;
    }
    if (arg === '--subject') {
      subject = argv[++i];
      continue;
    }
    if (arg?.startsWith('--subject=')) {
      subject = arg.slice('--subject='.length);
      continue;
    }
    if (arg === '--format') {
      const v = argv[++i];
      if (v !== 'markdown' && v !== 'json') {
        return { error: `unknown --format value: ${v ?? '<missing>'}` };
      }
      format = v;
      continue;
    }
    if (arg?.startsWith('--format=')) {
      const v = arg.slice('--format='.length);
      if (v !== 'markdown' && v !== 'json') return { error: `unknown --format value: ${v}` };
      format = v;
      continue;
    }
    if (arg === '-h' || arg === '--help') return { error: 'help' };
    return { error: `unknown argument: ${String(arg)}` };
  }

  if (!event) return { error: 'missing required flag: --event <EventType>' };
  return { event, subject, format };
}

function renderMarkdown(ripple: RippleSet, yamlServiceCount: number): string {
  const lines: string[] = [];
  lines.push(`# Ripple set for event \`${ripple.eventType}\``);
  lines.push('');
  lines.push(`**Subject**: \`${ripple.subject}\``);
  lines.push('');
  if (ripple.producers.length === 0) {
    lines.push(
      '> **No producer found.** Either the event type is spelled wrong, the ' +
        "subject was not added to the producer service's `publish:` list in " +
        'infrastructure/nats/services.yaml, or the event does not travel over ' +
        'NATS. Fix the producer yaml + regenerate nats.conf + rerun.',
    );
    return lines.join('\n') + '\n';
  }

  const producerNames = ripple.producers.map((p) => `\`${p.name}\``).join(', ');
  lines.push(`**Producer(s)**: ${producerNames}`);
  lines.push('');
  lines.push(`**Subscribers** (${ripple.subscribers.length} of ${yamlServiceCount} services):`);
  lines.push('');

  if (ripple.subscribers.length === 0) {
    lines.push(
      '_No subscribers yet — the event is published but unmatched by any subscribe filter._',
    );
  } else {
    lines.push('| Service | Matching subscribe pattern | Description |');
    lines.push('|---|---|---|');
    for (const { service, matchingPattern } of ripple.subscribers) {
      const desc = service.description ?? '';
      lines.push(`| \`${service.name}\` | \`${matchingPattern}\` | ${desc} |`);
    }
  }

  lines.push('');
  lines.push('## Contract-change dispatch checklist');
  lines.push('');
  lines.push('Per the `change-event-contract` skill (Step 3 consumer enumeration):');
  lines.push('');
  for (const { service } of ripple.subscribers) {
    lines.push(
      `- [ ] Dispatch review to the agent owning \`${service.name}\` (consult orchestrator routing table). Confirm its subscriber handles the new event shape (dual-publish window) before producer cleanup.`,
    );
  }
  if (ripple.subscribers.length === 0) {
    lines.push('- _(no subscribers — dispatch is limited to the producer)_');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- This ripple set is derived from the static `subscribe:` patterns in ' +
      'infrastructure/nats/services.yaml. A service that subscribes dynamically ' +
      'via a runtime-computed subject (rare; flagged by nats-invariants) would ' +
      'not appear here — re-verify such cases manually.',
  );
  lines.push(
    '- Add a service to / remove a service from the ripple set by editing ' +
      'services.yaml + regenerating `infrastructure/docker/nats/nats.conf`. ' +
      'Pair-change is enforced by `e2e/tests/integration/nats-invariants.spec.ts`.',
  );

  return lines.join('\n') + '\n';
}

function renderJson(ripple: RippleSet, yamlServiceCount: number): string {
  return JSON.stringify(
    {
      event_type: ripple.eventType,
      subject: ripple.subject,
      yaml_service_count: yamlServiceCount,
      producers: ripple.producers.map((p) => ({
        name: p.name,
        description: p.description ?? null,
      })),
      subscribers: ripple.subscribers.map(({ service, matchingPattern }) => ({
        name: service.name,
        description: service.description ?? null,
        matching_pattern: matchingPattern,
      })),
    },
    null,
    2,
  );
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      console.error(
        'Usage: ripple-tracer --event <EventType> [--subject <override>] [--format markdown|json]',
      );
      process.exit(2);
    }
    console.error(`ripple-tracer: ${parsed.error}`);
    console.error(
      'Usage: ripple-tracer --event <EventType> [--subject <override>] [--format markdown|json]',
    );
    process.exit(2);
  }

  let yaml: ServicesYaml;
  try {
    const yamlPath = resolve(REPO_ROOT, 'infrastructure', 'nats', 'services.yaml');
    yaml = parseServicesYaml(readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    console.error(`ripple-tracer: failed to parse services.yaml — ${(err as Error).message}`);
    process.exit(3);
  }

  const ripple = computeRipple(yaml, parsed.event, parsed.subject);
  const output =
    parsed.format === 'json'
      ? renderJson(ripple, yaml.services.length)
      : renderMarkdown(ripple, yaml.services.length);

  const defaultSubject = defaultSubjectFor(parsed.event);
  const usingDefaultSubject = !parsed.subject || parsed.subject === defaultSubject;
  const exitCode = usingDefaultSubject && ripple.producers.length === 0 ? 1 : 0;

  process.stdout.write(output);
  if (!output.endsWith('\n')) process.stdout.write('\n');
  process.exit(exitCode);
}

main();
