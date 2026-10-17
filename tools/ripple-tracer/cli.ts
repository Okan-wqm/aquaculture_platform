#!/usr/bin/env ts-node
/**
 * ripple-tracer — CLI entry.
 *
 * Given an event type, answers "which services publish it and which services' NATS grants admit
 * it?" from the ADR-015 cert-is-identity SSoT (infrastructure/nats/services.yaml).
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

import {
  aclEventRipple,
  eventSubjectsFor,
  type GrantMatch,
  loadNatsServices,
  type NatsServiceEntry,
  NatsServicesInvalid,
} from '../gates/nats-services';

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
  overrideSubject?: string,
): RippleReport {
  const derived = eventSubjectsFor(eventType, services);
  const subjects = overrideSubject === undefined ? derived.subjects : [overrideSubject];
  const ripple = aclEventRipple(eventType, services, subjects);
  return {
    eventType,
    subjects,
    subjectSource: overrideSubject === undefined ? derived.source : 'override',
    serviceCount: services.length,
    producers: ripple.producers,
    aclSubscribers: ripple.aclSubscribers,
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
    `**ACL subscribers** (${report.aclSubscribers.length} of ${report.serviceCount} services):`,
  );
  lines.push('');
  if (report.aclSubscribers.length === 0) {
    lines.push('_No subscribe grant admits these subjects._');
  } else {
    lines.push('| Application | NATS identity | Subscribe grant | Subject | Catch-all |');
    lines.push('|---|---|---|---|---|');
    for (const { service, grant, subject, catchAll } of report.aclSubscribers) {
      lines.push(
        `| \`${service.application}\` | \`${service.name}\` | \`${grant}\` | \`${subject}\` | ${catchAll ? 'yes' : 'no'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Contract-change dispatch checklist');
  lines.push('');
  lines.push('Per the `change-event-contract` skill (Step 3 consumer enumeration):');
  lines.push('');
  for (const { service } of report.aclSubscribers) {
    lines.push(
      `- [ ] Dispatch review to the agent owning \`${service.application}\` (consult orchestrator routing table). Confirm it handles the new event shape (dual-publish window) before producer cleanup.`,
    );
  }
  if (report.aclSubscribers.length === 0) {
    lines.push('- _(no subscribe grant admits the event; dispatch is limited to the producer)_');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- These are NATS ACL grants, which say who MAY receive the event. A catch-all grant ' +
      '(`events.>`) is a permission, not evidence that the service consumes the event.',
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
  const report = computeRipple(parsed.event, services, parsed.subject);
  const output = parsed.format === 'json' ? renderJson(report) : renderMarkdown(report);
  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  process.exit(report.producers.length === 0 ? 1 : 0);
}

if (require.main === module) main();
