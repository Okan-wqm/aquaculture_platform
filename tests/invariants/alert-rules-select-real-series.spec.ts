/**
 * An alert rule selects a series something actually emits (OBS-CRITICAL-003).
 *
 * `NotificationChannelFailing` selected `http_requests_total{...,status=~"5.."}`.
 * The emitted label is `status_code`, so the selector matched nothing, so the
 * alert could never fire — a pager that reports "all clear" because it is asking
 * a question the data cannot answer. Nothing caught it: promtool validates
 * syntax, not whether a series exists, and the rule looks correct at a glance.
 * `10-service-health.yml` records fixing the identical mistake when these rules
 * were extracted, which is how a one-off correction becomes a class of bug that
 * comes back.
 *
 * That is the same defect class as the whole ADMIN-HIGH-014 finding — a reader
 * with no producer — expressed in PromQL instead of TypeScript. So it gets the
 * same treatment:
 *
 *   1. every metric family a droplet rule selects is emitted somewhere in this
 *      repository, or is named on the exporter allowlist below with the
 *      exporter that provides it;
 *   2. every label a rule constrains on the shared HTTP families is one the
 *      metrics service declares — which is exactly the check that would have
 *      caught `status` vs `status_code`.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#OBS-CRITICAL-003
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RULES_DIR = 'infrastructure/monitoring/droplet/rules';
const METRICS_SERVICE = 'libs/backend-common/src/metrics/metrics.service.ts';

/** Where a metric may legitimately come from if this repository does not emit it. */
const EXPORTER_PROVIDED: Record<string, string> = {
  container_cpu_usage_seconds_total: 'cAdvisor',
  container_memory_working_set_bytes: 'cAdvisor',
  container_spec_cpu_period: 'cAdvisor',
  container_spec_cpu_quota: 'cAdvisor',
  container_spec_memory_limit_bytes: 'cAdvisor',
  up: 'Prometheus itself (target liveness)',
};

/** PromQL functions and keywords that share the identifier shape of a metric. */
const PROMQL_KEYWORDS = new Set([
  'rate',
  'irate',
  'increase',
  'delta',
  'deriv',
  'predict_linear',
  'changes',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_values',
  'stddev',
  'stdvar',
  'quantile',
  'topk',
  'bottomk',
  'histogram_quantile',
  'absent',
  'absent_over_time',
  'clamp',
  'clamp_max',
  'clamp_min',
  'round',
  'abs',
  'ceil',
  'floor',
  'exp',
  'ln',
  'time',
  'timestamp',
  'vector',
  'scalar',
  'label_replace',
  'label_join',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'offset',
  'avg_over_time',
  'sum_over_time',
  'max_over_time',
  'min_over_time',
  'count_over_time',
  'last_over_time',
  'present_over_time',
  'stddev_over_time',
]);

/** Label sets the shared metrics service declares, keyed by family. */
const HTTP_FAMILIES = [
  'http_request_duration_seconds',
  'http_requests_total',
  'http_requests_in_flight',
];
/** Labels every scraped series carries from the file_sd target definition. */
const TARGET_LABELS = new Set(['app', 'namespace', 'criticality', 'instance', 'job', 'le']);

interface AlertRule {
  alert?: string;
  record?: string;
  expr: string;
}

function ruleFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', `${RULES_DIR}/*.yml`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function rulesIn(file: string): AlertRule[] {
  const doc = yaml.load(readFileSync(join(REPO_ROOT, file), 'utf8')) as {
    groups: Array<{ rules?: AlertRule[] }>;
  };
  return doc.groups.flatMap((group) => group.rules ?? []);
}

/** An expression with its `#` comments removed — a commented metric is not selected. */
function expression(rule: AlertRule): string {
  return rule.expr.replace(/#.*$/gm, '');
}

function metricsIn(expr: string): string[] {
  return [...expr.matchAll(/\b([a-z_][a-z0-9_]*)\s*[{[]/g)]
    .map((match) => match[1] as string)
    .filter((name) => !PROMQL_KEYWORDS.has(name));
}

/** Selector labels applied to one metric family inside an expression. */
function labelsFor(expr: string, family: string): string[] {
  const labels: string[] = [];
  for (const match of expr.matchAll(
    new RegExp(`\\b${family}(?:_bucket|_count|_sum)?\\s*\\{([^}]*)\\}`, 'g'),
  )) {
    for (const pair of (match[1] as string).matchAll(/(\w+)\s*(?:=~|!~|!=|=)/g)) {
      labels.push(pair[1] as string);
    }
  }
  return labels;
}

function emittedSomewhere(metric: string): boolean {
  const base = metric.replace(/_(bucket|count|sum)$/, '');
  const result = execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'grep',
      '-l',
      '-F',
      '--',
      base,
      '--',
      'apps',
      'libs',
      'platform',
      'tools',
      'sens-api-gateway',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  return result.length > 0;
}

describe('INVARIANT (OBS-CRITICAL-003): an alert rule selects a series something emits', () => {
  const files = ruleFiles();
  const allRules = files.flatMap((file) => rulesIn(file).map((rule) => ({ file, rule })));

  it('sees the rule set', () => {
    // A moved directory would otherwise make every case below vacuous.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(allRules.length).toBeGreaterThanOrEqual(20);
  });

  it('every metric family a rule selects is emitted by this repo or a named exporter', () => {
    const orphans: string[] = [];
    for (const { file, rule } of allRules) {
      for (const metric of metricsIn(expression(rule))) {
        if (metric in EXPORTER_PROVIDED) continue;
        if (emittedSomewhere(metric)) continue;
        orphans.push(
          `${file}: ${rule.alert ?? rule.record ?? '?'} selects ${metric}, which nothing emits`,
        );
      }
    }
    expect(orphans).toEqual([]);
  });

  it('every label a rule constrains on the shared HTTP families is one the code emits', () => {
    // The check that would have caught `status=~"5.."` — the emitted label is
    // `status_code`, so the selector matched nothing and the alert never fired.
    const metricsSource = readFileSync(join(REPO_ROOT, METRICS_SERVICE), 'utf8');
    const declared = new Set(
      [...metricsSource.matchAll(/labelNames:\s*\[([^\]]*)\]/g)].flatMap((match) =>
        [...(match[1] as string).matchAll(/'(\w+)'/g)].map((label) => label[1] as string),
      ),
    );
    expect(declared.size).toBeGreaterThanOrEqual(3);

    const unknown: string[] = [];
    for (const { file, rule } of allRules) {
      const expr = expression(rule);
      for (const family of HTTP_FAMILIES) {
        for (const label of labelsFor(expr, family)) {
          if (declared.has(label) || TARGET_LABELS.has(label)) continue;
          unknown.push(
            `${file}: ${rule.alert ?? rule.record ?? '?'} constrains ${family}{${label}=…}, which the metrics service does not emit`,
          );
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the exporter allowlist names only metrics some rule actually uses', () => {
    // An allowlist entry for a metric nothing selects is a waiver with no
    // subject; it should leave rather than be carried.
    const selected = new Set(allRules.flatMap(({ rule }) => metricsIn(expression(rule))));
    const stale = Object.keys(EXPORTER_PROVIDED).filter((metric) => !selected.has(metric));
    expect(stale).toEqual([]);
  });
});
