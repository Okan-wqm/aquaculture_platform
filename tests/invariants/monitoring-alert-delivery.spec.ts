/**
 * An alert that cannot be delivered, and a label Prometheus will rename.
 * ============================================================================
 *
 * # Why this exists
 *
 * Two defects found by auditing alerting work that had already been reviewed
 * and merged. Both share a shape: the artefact is syntactically valid, passes
 * `promtool check rules`, and does nothing.
 *
 * ## 1. A severity with no route
 *
 * `alertmanager.yml` routes on `severity` and its default receiver is `null`.
 * It defines routes for exactly three values — `critical`, `warning`, `none`.
 * Eight rules in `60-dataflow-integrity.yml` shipped `severity: high` or
 * `severity: medium`, which are not wrong so much as unrouteable: every one of
 * them matched the default route and was silently discarded. Nothing failed.
 * `promtool` is happy with any label value, and Alertmanager does not warn
 * about alerts it drops on purpose.
 *
 * ## 2. A label Prometheus reserves
 *
 * `job` is the scrape-target label. With `honor_labels: false` — the default,
 * and what this platform runs — a metric carrying its own `job` has it renamed
 * to `exported_job` on ingest. A rule written as `max by (job) (...)` then
 * groups by the scrape target instead, collapsing every scheduled job in a
 * service into one series, and `{{ $labels.job }}` names the service rather
 * than the job that stopped. Verified empirically on the production droplet:
 * the `farm_regulatory_cron_*` family sits under `exported_job` today.
 *
 * # What this asserts
 *
 * Every severity used by a rule reaches a receiver, and no exported metric
 * declares a reserved label. Both are read from the real files, so the
 * assertion tracks the config rather than a copy of it.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RULES_DIR = path.join(REPO_ROOT, 'infrastructure/monitoring/droplet/rules');
const ALERTMANAGER = path.join(REPO_ROOT, 'infrastructure/monitoring/droplet/alertmanager.yml');

/**
 * Labels Prometheus attaches itself during a scrape. A metric that exports one
 * of these does not override it — it gets renamed to `exported_<label>`, and
 * every rule written against the original name silently means something else.
 * https://prometheus.io/docs/concepts/jobs_instances/
 */
const RESERVED_PROMETHEUS_LABELS = ['job', 'instance'];

interface AlertRule {
  alert?: string;
  expr?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface RuleGroup {
  name?: string;
  rules?: AlertRule[];
}
interface RuleFile {
  groups?: RuleGroup[];
}
interface Route {
  receiver?: string;
  matchers?: string[];
  routes?: Route[];
}
interface AlertmanagerConfig {
  route?: Route;
  receivers?: Array<{
    name?: string;
    webhook_configs?: unknown[];
    email_configs?: Array<{ to?: string }>;
  }>;
}

function ruleFiles(): string[] {
  return fs
    .readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => path.join(RULES_DIR, f));
}

function allRules(): Array<{ file: string; rule: AlertRule }> {
  const out: Array<{ file: string; rule: AlertRule }> = [];
  for (const file of ruleFiles()) {
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as RuleFile;
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (rule.alert) out.push({ file: path.basename(file), rule });
      }
    }
  }
  return out;
}

/** Severity values that reach a receiver other than the drop-everything default. */
function routedSeverities(config: AlertmanagerConfig): Set<string> {
  const routed = new Set<string>();
  const walk = (route: Route | undefined): void => {
    if (!route) return;
    for (const child of route.routes ?? []) {
      for (const matcher of child.matchers ?? []) {
        const match = /^\s*severity\s*=\s*"?([\w-]+)"?\s*$/.exec(matcher);
        const severity = match?.[1];
        if (severity && child.receiver && child.receiver !== 'null') routed.add(severity);
      }
      walk(child);
    }
  };
  walk(config.route);
  return routed;
}

describe('alerts can actually be delivered', () => {
  const config = yaml.load(fs.readFileSync(ALERTMANAGER, 'utf8')) as AlertmanagerConfig;

  it('routes every severity that a rule actually uses', () => {
    const routed = routedSeverities(config);
    expect(routed.size).toBeGreaterThan(0);

    const unroutable = allRules()
      .filter(({ rule }) => {
        const severity = rule.labels?.severity;
        return typeof severity === 'string' && !routed.has(severity);
      })
      .map(({ file, rule }) => `${file}:${rule.alert} severity=${rule.labels?.severity}`);

    // Failing here means the alert fires into Alertmanager and is dropped by
    // the default route. Either use a severity that has a route, or add the
    // route — but not a third vocabulary nobody translates.
    expect(unroutable).toEqual([]);
  });

  it('keeps the drop-everything default that makes the check above meaningful', () => {
    // If the default receiver stopped being `null`, an unrouted severity would
    // still be delivered somewhere and the assertion above would be theatre.
    expect(config.route?.receiver).toBe('null');
  });

  it('points every route at a receiver that exists', () => {
    const declared = new Set((config.receivers ?? []).map((r) => r.name));
    const missing: string[] = [];
    const walk = (route: Route | undefined): void => {
      if (!route) return;
      if (route.receiver && !declared.has(route.receiver)) missing.push(route.receiver);
      for (const child of route.routes ?? []) walk(child);
    };
    walk(config.route);

    expect(missing).toEqual([]);
  });

  it('gives every routed receiver something that actually delivers', () => {
    // A severity can have a route, the route can name a receiver, and the
    // receiver can still contain nothing — which is what `page` and `digest`
    // effectively were while they pointed at a loopback URL nobody served.
    // Being routed is not the same as being delivered.
    const routed = new Set<string>();
    const walk = (route: Route | undefined): void => {
      if (!route) return;
      for (const child of route.routes ?? []) {
        if (child.receiver && child.receiver !== 'null') routed.add(child.receiver);
        walk(child);
      }
    };
    walk(config.route);

    const empty = (config.receivers ?? [])
      .filter((r) => r.name && routed.has(r.name))
      .filter((r) => (r.email_configs?.length ?? 0) === 0 && (r.webhook_configs?.length ?? 0) === 0)
      .map((r) => r.name);

    expect(empty).toEqual([]);
  });

  it('commits no real recipient and no real credential', () => {
    // Delivery settings are rendered onto the droplet at activation. The
    // committed file must stay unusable on purpose: `.invalid` is reserved by
    // RFC 2606 and can never resolve, so a config that reached production
    // unrendered fails loudly instead of quietly mailing a stranger.
    const raw = fs.readFileSync(ALERTMANAGER, 'utf8');
    const recipients = [...raw.matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1] ?? '');

    expect(recipients.length).toBeGreaterThan(0);
    for (const recipient of recipients) {
      expect(recipient).toMatch(/\.invalid$/);
    }
    expect(raw).toContain('REPLACE_SMTP_PASSWORD');
  });

  it('never exports a metric label Prometheus reserves for itself', () => {
    const offenders: string[] = [];
    const sources = ['apps', 'libs', 'platform'].map((d) => path.join(REPO_ROOT, d));

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const match of text.matchAll(/labelNames:\s*\[([^\]]*)\]/g)) {
          const declared = match[1];
          if (declared === undefined) continue;
          const labels = declared
            .split(',')
            .map((l) => l.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
          for (const reserved of RESERVED_PROMETHEUS_LABELS) {
            if (labels.includes(reserved)) {
              offenders.push(
                `${path.relative(REPO_ROOT, full)} declares reserved label '${reserved}'`,
              );
            }
          }
        }
      }
    };
    sources.forEach(walk);

    // Prometheus will not reject these — it renames them, which is worse,
    // because every rule written against the original name keeps parsing.
    expect(offenders).toEqual([]);
  });

  it('does not group cron rules by the scrape-target label', () => {
    // The specific misreading the rename above prevents: `by (job)` on a
    // cron metric groups by service, so one dead job and one healthy job in
    // the same service become a single series.
    const offenders = allRules()
      .filter(
        ({ rule }) =>
          /cron_job_|_cron_/.test(rule.expr ?? '') &&
          (/\bby\s*\(\s*job\s*\)/.test(rule.expr ?? '') ||
            /\$labels\.job\b/.test(JSON.stringify(rule.annotations ?? {}))),
      )
      .map(({ file, rule }) => `${file}:${rule.alert}`);

    expect(offenders).toEqual([]);
  });
});
