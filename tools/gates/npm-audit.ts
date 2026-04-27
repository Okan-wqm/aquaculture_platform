#!/usr/bin/env ts-node
/**
 * npm-audit — supply-chain dependency-vulnerability gate (plan v3 R30).
 * ============================================================================
 *
 * Runs `npm audit --json --production=false` and fails when any
 * advisory at or above the configured severity threshold is present.
 *
 * # Thresholds
 *
 *   --fail-on <level>   critical | high | moderate | low
 *                       Default: 'high'. The gate fails when the
 *                       audit report contains ≥1 advisory at or
 *                       above this severity.
 *
 *   --allow <id>[,<id>...]  Numeric advisory IDs to allowlist (e.g.
 *                       comma-separated "1095081,1095125"). Each
 *                       allowlist entry MUST also appear in
 *                       docs/security/npm-audit-allowlist.yaml
 *                       with a documented justification + expiry;
 *                       a CI follow-up cross-check enforces that.
 *                       Present in the CLI here so local operators
 *                       can exercise the filter before adding to
 *                       the yaml.
 *
 *   --json               Emit a structured report instead of the
 *                        human-readable summary.
 *
 * # Exit codes
 *
 *   0  no advisories ≥ threshold (after allowlist filtering)
 *   1  one or more blocking advisories present
 *   2  input or subprocess failure
 *
 * # Why this gate exists
 *
 * Plan v3 R30 promoted supply-chain as a Phase 1 CI gate. Without
 * `npm audit` running on every PR, transitively-pulled critical CVEs
 * can land silently — the 146-finding Dependabot report on main
 * shows how fast the surface grows when no gate is in place.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

interface NpmAuditAdvisory {
  readonly id?: number;
  readonly github_advisory_id?: string;
  readonly severity: Severity;
  readonly title?: string;
  readonly module_name?: string;
  readonly url?: string;
}

interface NpmAuditReport {
  readonly vulnerabilities?: Record<
    string,
    {
      readonly severity: Severity;
      readonly via?: Array<string | NpmAuditAdvisory>;
      readonly effects?: readonly string[];
      readonly name?: string;
    }
  >;
  // npm 7+ may nest under metadata.vulnerabilities.counts
  readonly metadata?: {
    readonly vulnerabilities?: Record<Severity, number>;
  };
}

export interface NpmAuditArgs {
  readonly failOn: Severity;
  readonly allowlist: ReadonlySet<number>;
  readonly jsonMode: boolean;
}

export function parseArgs(argv: readonly string[]): NpmAuditArgs {
  let failOn: Severity = 'high';
  const allowlist = new Set<number>();
  let jsonMode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--fail-on': {
        const v = argv[++i] ?? '';
        if (!(v in SEVERITY_ORDER) || v === 'info') {
          throw new RangeError(
            `[npm-audit] --fail-on must be one of critical|high|moderate|low (got '${v}')`,
          );
        }
        failOn = v as Severity;
        break;
      }
      case '--allow': {
        const v = argv[++i] ?? '';
        for (const id of v.split(',').map((s) => s.trim()).filter(Boolean)) {
          const n = Number.parseInt(id, 10);
          if (!Number.isFinite(n)) {
            throw new RangeError(
              `[npm-audit] --allow entry '${id}' is not a numeric advisory id`,
            );
          }
          allowlist.add(n);
        }
        break;
      }
      case '--json':
        jsonMode = true;
        break;
      default:
        throw new RangeError(`[npm-audit] unknown argument: ${a}`);
    }
  }
  return { failOn, allowlist, jsonMode };
}

interface BlockingAdvisory {
  readonly module: string;
  readonly severity: Severity;
  readonly advisoryId: number | null;
  readonly title: string;
  readonly url: string | null;
}

export function summarize(
  report: NpmAuditReport,
  args: NpmAuditArgs,
): {
  readonly blocking: readonly BlockingAdvisory[];
  readonly countsBySeverity: Record<Severity, number>;
} {
  const countsBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0,
  };
  const blocking: BlockingAdvisory[] = [];
  const thresholdRank = SEVERITY_ORDER[args.failOn];
  const vulnerabilities = report.vulnerabilities ?? {};
  for (const [moduleName, vuln] of Object.entries(vulnerabilities)) {
    const sev = vuln.severity;
    if (sev in countsBySeverity) countsBySeverity[sev]++;
    if (SEVERITY_ORDER[sev] < thresholdRank) continue;
    // `via` is an array of strings (module names) OR advisory objects.
    const advisories = (vuln.via ?? []).filter(
      (v): v is NpmAuditAdvisory => typeof v === 'object' && v !== null,
    );
    if (advisories.length === 0) {
      // No advisory payload (transitively flagged). Still blocking
      // unless the module itself was allowlisted via ID match.
      blocking.push({
        module: vuln.name ?? moduleName,
        severity: sev,
        advisoryId: null,
        title: 'transitive vulnerability',
        url: null,
      });
      continue;
    }
    for (const adv of advisories) {
      if (adv.id !== undefined && args.allowlist.has(adv.id)) continue;
      blocking.push({
        module: vuln.name ?? moduleName,
        severity: sev,
        advisoryId: adv.id ?? null,
        title: adv.title ?? 'unknown',
        url: adv.url ?? null,
      });
    }
  }
  return { blocking, countsBySeverity };
}

export function runNpmAudit(): NpmAuditReport {
  const res = spawnSync(
    'npm',
    ['audit', '--json', '--production=false'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // npm audit exits non-zero when vulnerabilities exist — that's
      // EXPECTED here; we parse the JSON regardless of exit code.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (res.error) {
    throw new Error(`[npm-audit] spawn failed: ${res.error.message}`);
  }
  const raw = res.stdout;
  if (!raw || raw.trim().length === 0) {
    throw new Error('[npm-audit] empty stdout from `npm audit`');
  }
  let parsed: NpmAuditReport;
  try {
    parsed = JSON.parse(raw) as NpmAuditReport;
  } catch (e) {
    throw new Error(
      `[npm-audit] failed to parse audit JSON: ${(e as Error).message}`,
    );
  }
  return parsed;
}

/**
 * Injected-report variant for tests. Production CLI calls runNpmAudit().
 */
export function runCheck(
  report: NpmAuditReport,
  args: NpmAuditArgs,
): { readonly exitCode: 0 | 1; readonly summary: ReturnType<typeof summarize> } {
  const summary = summarize(report, args);
  return {
    exitCode: summary.blocking.length === 0 ? 0 : 1,
    summary,
  };
}

export function printUsage(): void {
  process.stdout.write(
    `Usage: tools/gates/npm-audit.ts [--fail-on <level>] [--allow <id>,<id>] [--json]\n` +
      `  --fail-on critical|high|moderate|low   default 'high'\n` +
      `  --allow  comma-separated advisory IDs\n` +
      `  --json   machine-readable report\n`,
  );
}

export function main(argv: readonly string[]): number {
  let args: NpmAuditArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    printUsage();
    return 2;
  }
  let report: NpmAuditReport;
  try {
    report = runNpmAudit();
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const { exitCode, summary } = runCheck(report, args);
  if (args.jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          failOn: args.failOn,
          blockingCount: summary.blocking.length,
          countsBySeverity: summary.countsBySeverity,
          blocking: summary.blocking,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const c = summary.countsBySeverity;
    process.stdout.write(
      `npm-audit: failOn=${args.failOn} — ` +
        `critical=${c.critical} high=${c.high} moderate=${c.moderate} low=${c.low} ` +
        `blocking=${summary.blocking.length}\n`,
    );
    if (summary.blocking.length > 0) {
      process.stdout.write('\n── BLOCKING ADVISORIES ──\n');
      for (const b of summary.blocking) {
        process.stdout.write(
          `  [${b.severity}] ${b.module}` +
            (b.advisoryId !== null ? ` advisory=${b.advisoryId}` : '') +
            ` — ${b.title}\n`,
        );
      }
      process.stdout.write(
        '\n✗ Plan v3 R30: supply-chain advisories ≥ threshold must be resolved or explicitly allowlisted with justification.\n',
      );
    } else {
      process.stdout.write('✓ No advisories at or above threshold.\n');
    }
  }
  return exitCode;
}

if (process.argv[1]?.endsWith('npm-audit.ts')) {
  process.exit(main(process.argv.slice(2)));
}
