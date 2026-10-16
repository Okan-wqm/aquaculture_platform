/**
 * Measured lint debt: the one owner of how the affected lane's lint quarantine
 * is renewed, and of what may never be renewed.
 *
 * WHY. `targets.lint.knownUnstableProjects` in scripts/ci/affected-target-policy.json
 * held 40 entries that all expired on 2026-10-31, a single date chosen without
 * any measurement, owned by the operator, with nothing that renewed or paid
 * them down. The writer then refused the WHOLE policy file once any entry was
 * past its date, so from 2026-11-01 every affected lane that reads it (lint,
 * test, test:integration, test:contract, test:invariant) would have failed on
 * every PR and main push. A deadline nobody acts on is a cliff, not a forcing
 * function. An expired entry now gates its own project strictly instead
 * (scripts/ci/lib/affected-target-policy.mjs); this module bounds how long a
 * renewal may defer that.
 *
 * WHAT.
 *   - The debt of every quarantined project is MEASURED (scripts/ci/lint-debt-measure.mjs)
 *     and committed next to the policy (scripts/ci/lint-debt-measurement.json),
 *     anchored on the commit it was taken at.
 *   - An entry's expiry is a bounded function of that debt
 *     (`lintQuarantineExpiryBound`): measured day + 14 d + 7 d per 25 blocking
 *     problems, at most 90 d. Renewal writes the bound; verification refuses
 *     anything later. Both use the same function.
 *   - A project that measures clean leaves the quarantine.
 *   - A project with any SECURITY-CLASS blocking lint problem is never renewed
 *     (HL safety review 2026-10-16, binding). The lint lane enforces the
 *     getRepository tenant-isolation rule, the JWT_SECRET rules and the
 *     aquaculture tenant/SSRF/XSS rules; a quarantine keeps every exemption
 *     alive with no person deciding, so security lint is paid down first.
 *     The classification is fail-closed: an unknown `aquaculture/*` rule, an
 *     unknown `no-restricted-syntax` message and a file ESLint cannot parse
 *     all count as security-class.
 */

import { ISO_DATE } from './reviewed-exception.mjs';

export const MEASUREMENT_SCHEMA = 'aqua.lint-debt-measurement.v1';

/** The renewing agent owns a renewed entry; the operator keeps the CODEOWNERS review. */
export const LINT_QUARANTINE_OWNER = 'claude';

export const RENEWAL = Object.freeze({
  baseDays: 14,
  stepDays: 7,
  stepProblems: 25,
  maxDays: 90,
});

const DAY_MS = 86_400_000;
const GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * `aquaculture/*` rules that guard neither tenant isolation, authentication,
 * request forgery, markup injection nor the AI safety pipeline. Every other
 * plugin rule, including one added later, is security-class until it is
 * listed here.
 */
export const NON_SECURITY_AQUACULTURE_RULES = Object.freeze([
  'aquaculture/no-bare-graphql-query-string',
  'aquaculture/no-direct-event-publish',
  'aquaculture/no-high-cardinality-metric-label',
]);

/** Core rules that guard a code-execution sink. */
export const CODE_EXECUTION_RULES = Object.freeze([
  'no-eval',
  'no-implied-eval',
  'no-new-func',
  '@typescript-eslint/no-implied-eval',
]);

/**
 * @param {string} isoDate YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD, UTC
 */
export function addDaysIso(isoDate, days) {
  const start = Date.parse(`${isoDate}T00:00:00Z`);
  if (!ISO_DATE.test(isoDate) || Number.isNaN(start)) {
    throw new RangeError(`not an ISO date: ${isoDate}`);
  }
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The latest expiry a lint quarantine entry may carry for a measured debt.
 *
 * @param {string} measuredOn YYYY-MM-DD the measurement was taken
 * @param {number} debt       blocking eslint problems measured in the project (>= 1)
 * @returns {string} YYYY-MM-DD
 */
export function lintQuarantineExpiryBound(measuredOn, debt) {
  if (!Number.isSafeInteger(debt) || debt < 1) {
    throw new RangeError(`a quarantine bound exists only for a measured debt >= 1, got ${debt}`);
  }
  const days = Math.min(
    RENEWAL.maxDays,
    RENEWAL.baseDays + RENEWAL.stepDays * Math.ceil(debt / RENEWAL.stepProblems),
  );
  return addDaysIso(measuredOn, days);
}

/**
 * Whether one ESLint message belongs to the security class.
 *
 * @param {{ruleId?: string | null, message?: string, fatal?: boolean}} message
 * @param {readonly string[]} nonSecurityRestrictedSyntax `no-restricted-syntax`
 *        messages that are not security rules (owned by eslint.config.mjs)
 * @returns {boolean}
 */
export function isSecurityClassMessage(message, nonSecurityRestrictedSyntax) {
  // A file ESLint cannot parse is checked by no rule at all, the security
  // rules included.
  if (message.fatal === true) return true;
  const ruleId = message.ruleId;
  if (typeof ruleId !== 'string') return false;
  if (ruleId === 'no-restricted-syntax') {
    return !nonSecurityRestrictedSyntax.includes(message.message ?? '');
  }
  if (ruleId.startsWith('aquaculture/')) {
    return !NON_SECURITY_AQUACULTURE_RULES.includes(ruleId);
  }
  return CODE_EXECUTION_RULES.includes(ruleId);
}

function ruleKey(message) {
  if (message.fatal === true) return '(parse-error)';
  return typeof message.ruleId === 'string' ? message.ruleId : '(directive)';
}

function bump(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Summarize the ESLint JSON results of one project's lint invocations.
 *
 * A problem is BLOCKING when it fails the lint target: every error, and every
 * warning of an invocation whose warnings exceed its `--max-warnings`. One
 * definition serves `debt`, `rules` and `security` alike, so `debt` is the sum
 * of `rules` and the bound is computed from the same problems the per-rule
 * counts name.
 *
 * @param {ReadonlyArray<{results: ReadonlyArray<{messages: ReadonlyArray<object>}>, maxWarnings: number | null}>} invocations
 * @param {readonly string[]} nonSecurityRestrictedSyntax
 * @returns {{errors: number, warnings: number, debt: number, security: number, rules: Record<string, number>, security_rules: Record<string, number>}}
 */
export function summarizeLintInvocations(invocations, nonSecurityRestrictedSyntax) {
  let errors = 0;
  let warnings = 0;
  let debt = 0;
  let security = 0;
  const rules = {};
  const securityRules = {};
  for (const { results, maxWarnings } of invocations) {
    const messages = results.flatMap((file) => file.messages);
    const invocationErrors = messages.filter((message) => message.severity === 2).length;
    const invocationWarnings = messages.filter((message) => message.severity === 1).length;
    const warningsBlock = maxWarnings !== null && invocationWarnings > maxWarnings;
    errors += invocationErrors;
    warnings += invocationWarnings;
    debt += invocationErrors + (warningsBlock ? invocationWarnings : 0);
    for (const message of messages) {
      if (message.severity !== 2 && !(warningsBlock && message.severity === 1)) continue;
      bump(rules, ruleKey(message));
      if (isSecurityClassMessage(message, nonSecurityRestrictedSyntax)) {
        security += 1;
        bump(securityRules, ruleKey(message));
      }
    }
  }
  return {
    errors,
    warnings,
    debt,
    security,
    rules: sortedCounts(rules),
    security_rules: sortedCounts(securityRules),
  };
}

const NX_ESLINT_OPTIONS = new Set(['lintFilePatterns', 'maxWarnings']);
const RUN_COMMANDS_OPTIONS = new Set(['cwd', 'command', 'commands', 'parallel']);
const RUN_SCRIPT_OPTIONS = new Set(['script']);
const TOOLCHAIN_PREFIX = /^node\s+(?:\S*\/)?tools\/toolchain\/run\.mjs\s+/;
const NPM_RUN = /^npm\s+run\s+([A-Za-z0-9:_-]+)$/;
const ESLINT_COMMAND = /^eslint(?:\s|$)/;
const SHELL_CONTROL = /[;&|`$<>(){}\\]/;
const MAX_WARNINGS = /--max-warnings(?:=|\s+)(\d+)/;

function refuseUnknownOptions(name, executor, options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${name}: ${executor} lint option(s) ${unknown.join(', ')} are not measurable`);
  }
}

function eslintCommand(name, command, cwd, packageScripts) {
  let text = String(command).trim();
  const npm = NPM_RUN.exec(text);
  if (npm) {
    const script = packageScripts[cwd]?.[npm[1]];
    if (typeof script !== 'string') {
      throw new Error(`${name}: ${cwd}/package.json has no "${npm[1]}" script`);
    }
    text = script.trim();
  }
  const bare = text.replace(TOOLCHAIN_PREFIX, '');
  if (!ESLINT_COMMAND.test(bare) || SHELL_CONTROL.test(bare)) {
    throw new Error(`${name}: lint command is not one plain eslint invocation: ${text}`);
  }
  const max = MAX_WARNINGS.exec(bare);
  return { cwd, mode: 'shell', command: text, maxWarnings: max ? Number(max[1]) : null };
}

/**
 * The eslint invocations a project's Nx `lint` target runs, so the
 * measurement lints exactly what the lane lints. Fail-closed: an executor,
 * option or command this cannot reproduce is refused, never approximated.
 *
 *   - `@nx/eslint:lint` lints its patterns from the workspace root, the
 *     patterns handed to ESLint unexpanded (mode argv);
 *   - `nx:run-commands` and `nx:run-script` run shell commands; `npm run <s>`
 *     resolves to that package's script; each must be one eslint command
 *     (mode shell, the shell expanding globs as it does in the lane).
 *
 * @param {{name: string, root: string, targets?: Record<string, {executor?: string, options?: Record<string, unknown>}>}} project
 * @param {Record<string, Record<string, string>>} packageScripts `scripts` of package.json, keyed by repo-relative directory
 * @returns {Array<{cwd: string, mode: 'argv' | 'shell', args?: string[], command?: string, maxWarnings: number | null}>}
 */
export function lintInvocations(project, packageScripts) {
  const target = project.targets?.lint;
  if (target === undefined) throw new Error(`${project.name}: has no lint target`);
  const options = target.options ?? {};
  const executor = target.executor;
  if (executor === '@nx/eslint:lint') {
    refuseUnknownOptions(project.name, executor, options, NX_ESLINT_OPTIONS);
    const patterns = options.lintFilePatterns ?? [project.root];
    const maxWarnings =
      typeof options.maxWarnings === 'number' && options.maxWarnings >= 0
        ? options.maxWarnings
        : null;
    return [{ cwd: '.', mode: 'argv', args: [...patterns], maxWarnings }];
  }
  if (executor === 'nx:run-commands') {
    refuseUnknownOptions(project.name, executor, options, RUN_COMMANDS_OPTIONS);
    const cwd = options.cwd ?? '.';
    const commands = options.commands ?? (options.command === undefined ? [] : [options.command]);
    if (commands.length === 0) throw new Error(`${project.name}: lint target runs no command`);
    return commands.map((entry) =>
      eslintCommand(
        project.name,
        typeof entry === 'string' ? entry : entry.command,
        cwd,
        packageScripts,
      ),
    );
  }
  if (executor === 'nx:run-script') {
    refuseUnknownOptions(project.name, executor, options, RUN_SCRIPT_OPTIONS);
    return [eslintCommand(project.name, `npm run ${options.script}`, project.root, packageScripts)];
  }
  throw new Error(`${project.name}: lint executor ${String(executor)} is not measurable`);
}

function lintQuarantine(policy) {
  return policy?.targets?.lint?.knownUnstableProjects ?? {};
}

/**
 * Rewrite every lint quarantine entry from a measurement.
 *
 *   - measured clean: the entry is deleted;
 *   - security-class debt: the entry is left exactly as it was and reported
 *     as refused (it is paid down, never renewed);
 *   - otherwise: owner claude, a reason naming the measurement, the bound as
 *     expiry, and the entry's own finding.
 *
 * @param {object} policy      parsed affected-target-policy.json (version 2)
 * @param {object} measurement parsed lint-debt-measurement.json
 * @returns {{policy: object, deleted: string[], renewed: string[], refused: string[], unmeasured: string[]}}
 */
export function renewLintQuarantine(policy, measurement) {
  const next = {};
  const outcome = { deleted: [], renewed: [], refused: [], unmeasured: [] };
  const entries = Object.entries(lintQuarantine(policy)).sort(([a], [b]) => a.localeCompare(b));
  for (const [project, entry] of entries) {
    const measured = measurement.projects[project];
    if (measured === undefined) {
      next[project] = entry;
      outcome.unmeasured.push(project);
    } else if (measured.debt === 0) {
      outcome.deleted.push(project);
    } else if (measured.security > 0) {
      next[project] = entry;
      outcome.refused.push(project);
    } else {
      next[project] = {
        owner: LINT_QUARANTINE_OWNER,
        reason:
          `${measured.debt} blocking eslint problems measured ${measurement.measured_at} at ` +
          `${measurement.measured_sha.slice(0, 12)}; paid down per project under ${entry.finding_id}.`,
        expires_on: lintQuarantineExpiryBound(measurement.measured_at, measured.debt),
        finding_id: entry.finding_id,
      };
      outcome.renewed.push(project);
    }
  }
  return {
    policy: {
      ...policy,
      targets: {
        ...policy.targets,
        lint: { ...policy.targets.lint, knownUnstableProjects: next },
      },
    },
    ...outcome,
  };
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Every problem that keeps the lint quarantine from being a measured one.
 *
 * The bound is computed from `measured_at`, so the date is pinned on both
 * sides: no earlier than the day its commit was made (a measurement cannot
 * predate the tree it measured) and no later than today (a renewing agent
 * cannot date a measurement into the future to move every bound).
 *
 * @param {object} policy
 * @param {unknown} measurement
 * @param {{isAncestorOfHead: (sha: string) => boolean, commitDayOf: (sha: string) => string | null}} history
 *        `commitDayOf` is the UTC committer day (YYYY-MM-DD) of a commit, null when unknown
 * @param {string} today YYYY-MM-DD, UTC
 * @returns {string[]} empty when every lint entry is measured, within its bound and renewable
 */
export function verifyLintQuarantine(policy, measurement, history, today) {
  const entries = Object.entries(lintQuarantine(policy));
  if (entries.length === 0) return [];
  const where = 'scripts/ci/lint-debt-measurement.json';
  if (measurement === null || typeof measurement !== 'object' || Array.isArray(measurement)) {
    return [`${where}: missing; ${entries.length} lint quarantine entries have no measurement`];
  }
  const problems = [];
  if (measurement.schema !== MEASUREMENT_SCHEMA) {
    problems.push(`${where}: schema is ${String(measurement.schema)}, not ${MEASUREMENT_SCHEMA}`);
  }
  const measuredAt = measurement.measured_at;
  const datedOk = typeof measuredAt === 'string' && ISO_DATE.test(measuredAt);
  if (!datedOk) {
    problems.push(`${where}: measured_at must be YYYY-MM-DD`);
  } else if (measuredAt > today) {
    problems.push(`${where}: measured_at ${measuredAt} is after today (${today})`);
  }
  const sha = measurement.measured_sha;
  if (typeof sha !== 'string' || !GIT_SHA.test(sha)) {
    problems.push(`${where}: measured_sha must be a full commit sha`);
  } else if (!history.isAncestorOfHead(sha)) {
    problems.push(
      `${where}: measured_sha ${sha} is not an ancestor of HEAD (a squash or rebase merge drops ` +
        'the measured commit); measure again on this history: node scripts/ci/lint-debt-measure.mjs ' +
        '--renew on a clean checkout of main',
    );
  } else if (datedOk) {
    const committed = history.commitDayOf(sha);
    if (committed === null) {
      problems.push(`${where}: the commit date of measured_sha ${sha} cannot be read`);
    } else if (measuredAt < committed) {
      problems.push(
        `${where}: measured_at ${measuredAt} is before ${committed}, the commit date of measured_sha`,
      );
    }
  }
  const projects = measurement.projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    problems.push(`${where}: projects must be an object`);
    return problems;
  }
  if (problems.length > 0) return problems;

  for (const [project, entry] of entries) {
    const measured = projects[project];
    const at = `lint/${project}`;
    if (measured === undefined) {
      problems.push(`${at}: has no measurement`);
    } else if (!isCount(measured.debt) || !isCount(measured.security)) {
      problems.push(`${at}: measurement must carry integer debt and security counts`);
    } else if (measured.debt === 0) {
      problems.push(`${at}: measured clean; delete the entry so the lane lints it`);
    } else if (measured.security > 0) {
      const rules = Object.keys(measured.security_rules ?? {}).join(', ');
      problems.push(
        `${at}: ${measured.security} security-class lint problems (${rules}); ` +
          'security lint is paid down, never renewed',
      );
    } else if (typeof entry?.expires_on !== 'string' || !ISO_DATE.test(entry.expires_on)) {
      problems.push(`${at}: expires_on must be YYYY-MM-DD`);
    } else {
      const bound = lintQuarantineExpiryBound(measurement.measured_at, measured.debt);
      if (entry.expires_on > bound) {
        problems.push(
          `${at}: expires ${entry.expires_on}, after ${bound}, the bound for ` +
            `${measured.debt} problems measured ${measurement.measured_at}`,
        );
      }
    }
  }
  return problems;
}
