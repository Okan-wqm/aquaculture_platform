#!/usr/bin/env ts-node
/**
 * ripple-tracer — CLI entry.
 *
 * Given an event type, answers "which services publish it, which services consume it, and whose
 * NATS grants admit it?". Producers and grants come from the ADR-015 cert-is-identity SSoT
 * (infrastructure/nats/services.yaml); consumers come from the code (ARIA-HIGH-313).
 *
 * Consumers are `eventConsumersFor` (tools/gates/event-consumer-index.ts), the same function the
 * plan-coverage witness uses: every subscription site in apps/, libs/ and platform/libs/ that the
 * type checker resolves to the event (durable JetStream consumers included, whose grants never
 * name the event), united with the subscribe grants that name it. A catch-all grant (`events.>`)
 * is a permission, not consumption; it is listed apart.
 *
 * The SSoT is read through tools/gates/nats-services.ts, the one reader every tool shares
 * (ARIA-MEDIUM-314): a YAML parse held to infrastructure/nats/services.schema.json, NATS subject
 * semantics, and the subjects an event travels on (the publish grants that name it, else the event
 * bus's default `events.*.<T>`). This file used to carry its own copy: a parser that accepted only
 * quoted list items and a default subject in the retired `AQUACULTURE_EVENTS.<T>.>` namespace, so
 * after the SSoT changed format it reported no producer and no subscriber for every event.
 *
 * Usage:
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType>
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType> --subject <subject-override>
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType> --format json
 *   ts-node tools/ripple-tracer/cli.ts --event <EventType> --services-yaml <path>
 *
 * Exit codes (contract — test scripts depend on these):
 *   0 — at least one service may publish the event on its subjects.
 *   1 — no service may publish it (a typo, a non-NATS event, or an override subject nobody
 *       publishes on).
 *   2 — usage error (missing / unknown flag).
 *   3 — services.yaml unreadable or refused by its schema.
 */

import { resolve } from 'node:path';

import {
  type ConsumerMatch,
  type EventConsumerIndex,
  eventConsumersFor,
  scanEventConsumers,
  type UnresolvedConsumerSite,
} from '../gates/event-consumer-index';
import {
  aclEventRipple,
  eventSubjectsFor,
  type GrantMatch,
  loadNatsServices,
  type NatsServiceEntry,
  NatsServicesInvalid,
} from '../gates/nats-services';

/** The checkout whose code is scanned for consumers: the one this tool lives in. */
const REPO_ROOT = resolve(__dirname, '..', '..');

type SubjectSource = 'declared' | 'default_root' | 'override';

interface Args {
  readonly event: string;
  readonly subject?: string;
  readonly servicesYaml?: string;
  readonly format: 'markdown' | 'json';
}

export interface RippleReport {
  readonly eventType: string;
  readonly subjects: readonly string[];
  readonly subjectSource: SubjectSource;
  readonly serviceCount: number;
  readonly producers: readonly GrantMatch[];
  readonly aclSubscribers: readonly GrantMatch[];
  /** Code subscriptions united with the grants naming the event (eventConsumersFor). */
  readonly consumers: readonly ConsumerMatch[];
  readonly aclCatchAll: readonly GrantMatch[];
  readonly unresolved: readonly UnresolvedConsumerSite[];
}

const USAGE =
  'Usage: ripple-tracer --event <EventType> [--subject <override>] [--services-yaml <path>] [--format markdown|json]';

function parseArgs(argv: readonly string[]): Args | { error: string } {
  let event: string | undefined;
  let subject: string | undefined;
  let servicesYaml: string | undefined;
  let format: 'markdown' | 'json' = 'markdown';
  const value = (flag: string, index: number): [string | undefined, number] => {
    const arg = argv[index] ?? '';
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1), index];
    return [argv[index + 1], index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const flag = arg.split('=', 1)[0];
    if (flag === '--event') [event, i] = value(flag, i);
    else if (flag === '--subject') [subject, i] = value(flag, i);
    else if (flag === '--services-yaml') [servicesYaml, i] = value(flag, i);
    else if (flag === '--format') {
      let chosen: string | undefined;
      [chosen, i] = value(flag, i);
      if (chosen !== 'markdown' && chosen !== 'json') {
        return { error: `unknown --format value: ${chosen ?? '<missing>'}` };
      }
      format = chosen;
    } else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else return { error: `unknown argument: ${arg}` };
  }
  if (!event) return { error: 'missing required flag: --event <EventType>' };
  return { event, subject, servicesYaml, format };
}

export function computeRipple(
  eventType: string,
  services: readonly NatsServiceEntry[],
  index: EventConsumerIndex,
  overrideSubject?: string,
): RippleReport {
  const derived = eventSubjectsFor(eventType, services);
  const subjects = overrideSubject === undefined ? derived.subjects : [overrideSubject];
  const ripple = aclEventRipple(eventType, services, subjects);
  const consumed = eventConsumersFor(eventType, index, services, subjects);
  return {
    eventType,
    subjects,
    subjectSource: overrideSubject === undefined ? derived.source : 'override',
    serviceCount: services.length,
    producers: ripple.producers,
    aclSubscribers: ripple.aclSubscribers,
    consumers: consumed.consumers,
    aclCatchAll: consumed.aclCatchAll,
    unresolved: index.unresolved,
  };
}

function renderMarkdown(report: RippleReport): string {
  const lines: string[] = [];
  lines.push(`# Ripple set for event \`${report.eventType}\``);
  lines.push('');
  lines.push(
    `**Subjects** (${report.subjectSource}): ${report.subjects.map((s) => `\`${s}\``).join(', ')}`,
  );
  lines.push('');
  if (report.producers.length === 0) {
    lines.push(
      '> **No producer found.** No service in infrastructure/nats/services.yaml may publish on ' +
        'these subjects: the event type is spelled wrong, the producer lacks its `publish:` grant ' +
        '(edit services.yaml, regenerate nats.conf, rerun), or the event does not travel over NATS.',
    );
    return `${lines.join('\n')}\n`;
  }
  const producerNames = report.producers
    .map(({ service, grant }) => `\`${service.application}\` (\`${service.name}\`, \`${grant}\`)`)
    .join(', ');
  lines.push(`**Producer(s)**: ${producerNames}`);
  lines.push('');
  lines.push(
    `**Consumers** (${report.consumers.length}): code subscriptions and grants naming the event`,
  );
  lines.push('');
  if (report.consumers.length === 0) {
    lines.push('_No subscription in the code and no grant naming the event._');
  } else {
    lines.push('| Application | Sources | Code sites | Grant |');
    lines.push('|---|---|---|---|');
    for (const consumer of report.consumers) {
      const sites = consumer.codeSites.map((site) => `\`${site}\``).join('<br>') || '—';
      const grant = consumer.acl === null ? '—' : `\`${consumer.acl.grant}\``;
      lines.push(
        `| \`${consumer.application}\` | ${consumer.sources.join(', ')} | ${sites} | ${grant} |`,
      );
    }
  }
  lines.push('');
  if (report.unresolved.length > 0) {
    lines.push(
      `> **${report.unresolved.length} subscription site(s) could not be resolved** and may consume ` +
        'this event; read them before dispatching:',
    );
    for (const site of report.unresolved) {
      lines.push(`> - \`${site.site}\` (${site.api}): \`${site.form}\``);
    }
    lines.push('');
  }
  lines.push('## Contract-change dispatch checklist');
  lines.push('');
  lines.push('Per the `change-event-contract` skill (Step 3 consumer enumeration):');
  lines.push('');
  for (const consumer of report.consumers) {
    const where = consumer.codeSites.length > 0 ? ` (${consumer.codeSites.join(', ')})` : '';
    lines.push(
      `- [ ] Dispatch review to the agent owning \`${consumer.application}\`${where} (consult orchestrator routing table). Confirm it handles the new event shape (dual-publish window) before producer cleanup.`,
    );
  }
  if (report.consumers.length === 0) {
    lines.push('- _(no consumer found; dispatch is limited to the producer)_');
  }
  lines.push('');
  lines.push('## Catch-all grants (permission only)');
  lines.push('');
  if (report.aclCatchAll.length === 0) {
    lines.push('_None._');
  } else {
    for (const { service, grant } of report.aclCatchAll) {
      lines.push(`- \`${service.application}\` (\`${service.name}\`, \`${grant}\`)`);
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- Consumers come from the code (tools/gates/event-consumer-index.ts): a durable JetStream ' +
      'consumer receives through `$JS.API.CONSUMER.>` and its inbox, so no grant names its event.',
  );
  lines.push(
    '- A catch-all grant (`events.>`) says a service MAY receive the event; it is a permission, ' +
      'not evidence that the service consumes the event.',
  );
  return `${lines.join('\n')}\n`;
}

function grantJson(match: GrantMatch): Record<string, unknown> {
  return {
    name: match.service.name,
    application: match.service.application,
    description: match.service.description,
    grant: match.grant,
    subject: match.subject,
    catch_all: match.catchAll,
  };
}

/** One line of JSON, the repo-wide shape for machine output (no indented stringify). */
function renderJson(report: RippleReport): string {
  return JSON.stringify({
    event_type: report.eventType,
    subjects: report.subjects,
    subject_source: report.subjectSource,
    yaml_service_count: report.serviceCount,
    producers: report.producers.map(grantJson),
    acl_subscribers: report.aclSubscribers.map(grantJson),
    consumer_source: 'code_subscriptions+acl_grants',
    consumers: report.consumers.map((consumer) => ({
      application: consumer.application,
      sources: consumer.sources,
      code_sites: consumer.codeSites,
      grant: consumer.acl?.grant ?? null,
      subject: consumer.subject,
    })),
    acl_catch_all: report.aclCatchAll.map(grantJson),
    unresolved: report.unresolved,
  });
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    if (parsed.error !== 'help') process.stderr.write(`ripple-tracer: ${parsed.error}\n`);
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  let services: readonly NatsServiceEntry[];
  try {
    services =
      parsed.servicesYaml === undefined
        ? loadNatsServices()
        : loadNatsServices(parsed.servicesYaml);
  } catch (error) {
    if (!(error instanceof NatsServicesInvalid)) throw error;
    process.stderr.write(`ripple-tracer: services.yaml: ${error.message}\n`);
    process.exit(3);
  }
  const report = computeRipple(
    parsed.event,
    services,
    scanEventConsumers(REPO_ROOT),
    parsed.subject,
  );
  const output = parsed.format === 'json' ? renderJson(report) : renderMarkdown(report);
  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  process.exit(report.producers.length === 0 ? 1 : 0);
}

if (require.main === module) main();
