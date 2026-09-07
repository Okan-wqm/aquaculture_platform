/**
 * A detective store has a producer, and that producer is REACHED
 * (ADMIN-HIGH-014, ADR-0018).
 *
 * `admin.login_attempts` and `admin.api_usage_logs` had readers and no writer.
 * Six detectors in `SecurityMonitoringService` — brute force by email, brute
 * force by IP, credential stuffing, geo anomaly, off-hours, API abuse —
 * counted rows in them, found 0 every time, and no threshold was ever
 * reachable. `getSecurityDashboardStats` therefore returned a health score of
 * 100 by construction: a security control that reported all-clear because it
 * could not see anything.
 *
 * The subtle part, and the reason this spec is shaped the way it is, is that
 * the writers DID exist. `ActivityLoggingService.recordLoginAttempt` and
 * `logApiUsage` were written, correct, and had ZERO callers. "Does something
 * write this table?" answered yes while the table stayed empty. So the
 * assertion is not that a writer exists but that it is **reached from a
 * runtime entry point** — a NATS consumer, a scheduled job or an HTTP route.
 *
 * The store set is DECLARED, not inferred. Inferring "which tables are
 * detective" from method names produces a call-graph approximation that fails
 * for reasons unrelated to the finding; a declaration fails only when the
 * platform actually changes, and adding a detector that reads a new store is
 * a deliberate line here.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DETECTOR_SERVICE =
  'apps/admin-api-service/src/security/services/security-monitoring.service.ts';

/** A class that the runtime can enter: a NATS consumer, a scheduled job, a route. */
const ENTRY_POINT_RE =
  /@(SubscribeTo|EventHandler|EventPattern|MessagePattern|ScheduledJob|Get|Post|Put|Patch|Delete)\(/;

interface DetectiveStore {
  /** The TypeORM entity the detectors read. */
  readonly entity: string;
  /** The service method that writes it. */
  readonly writer: string;
  /** The file that declares the writer. */
  readonly writerFile: string;
  /** The file that CALLS the writer, which must itself be a runtime entry point. */
  readonly reachedFrom: string;
}

/**
 * Every store a `SecurityMonitoringService` detector counts rows in.
 *
 * `SecurityEvent`, `SecurityIncident` and `ThreatIntelligence` are the
 * detectors' OUTPUT, not their input — they are written by the detectors
 * themselves and are deliberately absent.
 */
const DETECTIVE_STORES: readonly DetectiveStore[] = [
  {
    entity: 'LoginAttempt',
    writer: 'recordLoginAttempt',
    writerFile: 'apps/admin-api-service/src/security/services/activity-logging.service.ts',
    reachedFrom:
      'apps/admin-api-service/src/security/handlers/security-signal-projection.handler.ts',
  },
  {
    entity: 'ApiUsageLog',
    writer: 'logApiUsage',
    writerFile: 'apps/admin-api-service/src/security/services/activity-logging.service.ts',
    reachedFrom:
      'apps/admin-api-service/src/security/handlers/security-signal-projection.handler.ts',
  },
];

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** Source with comments stripped — a docblock naming a writer is not a call. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(...globs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...globs], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('INVARIANT (ADMIN-HIGH-014): a detective store has a producer that is reached', () => {
  const detectorSource = code(DETECTOR_SERVICE);

  it('sees the detectors', () => {
    // A rename that breaks the parser would otherwise make every case vacuous.
    const detectors = [...detectorSource.matchAll(/async ((?:check|analyze)[A-Z]\w+)\(/g)].map(
      (match) => match[1]!,
    );
    expect(detectors).toEqual(
      expect.arrayContaining([
        'analyzeLoginAttempt',
        'checkBruteForce',
        'checkCredentialStuffing',
        'checkGeoAnomaly',
        'checkTimeAnomaly',
        'checkApiAbuse',
      ]),
    );
  });

  it.each(DETECTIVE_STORES)('$entity is still read by a detector', ({ entity }) => {
    // Guards the declaration against going stale: a store nothing detects on
    // any more should leave this list rather than be carried forever.
    expect(detectorSource).toMatch(new RegExp(`Repository<${entity}>`));
  });

  it.each(DETECTIVE_STORES)('$entity has its writer, $writer', ({ entity, writer, writerFile }) => {
    const source = code(writerFile);
    const declaration = source.indexOf(`async ${writer}(`);
    expect(declaration).toBeGreaterThan(-1);
    // …and the writer really writes THAT entity, not merely shares a name.
    const repoField = new RegExp(`private readonly (\\w+): Repository<${entity}>`).exec(source);
    expect(repoField).not.toBeNull();
    // `.save(`, `.insert(` or the query-builder insert the idempotent
    // projection uses (`this.repo.createQueryBuilder().insert()`).
    expect(source.slice(declaration)).toMatch(
      new RegExp(`this\\.${repoField![1]!}\\s*\\.\\s*(save|insert|createQueryBuilder)\\(`),
    );
  });

  it.each(DETECTIVE_STORES)('$writer is called from $reachedFrom', ({ writer, reachedFrom }) => {
    // The assertion that would have caught the finding: the writer existed and
    // was correct; nothing invoked it.
    expect(code(reachedFrom)).toMatch(new RegExp(`\\.${writer}\\(`));
  });

  it.each(DETECTIVE_STORES)('$reachedFrom is a runtime entry point', ({ reachedFrom }) => {
    // A caller the runtime never enters is the same defect one level up.
    expect(code(reachedFrom)).toMatch(ENTRY_POINT_RE);
  });

  it('names every store a detector reads', () => {
    // The declaration is the SSoT, so it must be complete: a new detective
    // repository injected into the service without a line here fails now,
    // rather than silently counting an empty table in production.
    const injected = [...detectorSource.matchAll(/private readonly \w+: Repository<(\w+)>/g)].map(
      (match) => match[1]!,
    );
    // The detectors' own output tables are written by the detectors themselves.
    const OUTPUTS = ['SecurityEvent', 'SecurityIncident', 'ThreatIntelligence'];
    const inputs = injected.filter((entity) => !OUTPUTS.includes(entity));
    const declared = DETECTIVE_STORES.map((store) => store.entity);

    // Nothing is omitted any more. `UserSession` used to sit here as the one
    // deliberate exception — a store read by `checkSessionHijacking`, which had
    // no caller. That producer-or-delete decision was made: `admin.user_sessions`
    // and its detector were retired (migration `1809400000000`), because
    // `auth.refresh_tokens` already holds the session facts and no
    // session-lifecycle event exists to project from. An empty list is the
    // finding's end state, not an assertion nobody maintains.
    expect(inputs.filter((entity) => !declared.includes(entity))).toEqual([]);
  });

  it('has no admin service reading a detective store it does not declare', () => {
    // Catches the finding reappearing in a NEW service rather than this one.
    const others = listFiles('apps/admin-api-service/src/**/*.service.ts').filter(
      (file) => file !== DETECTOR_SERVICE && !file.includes('__tests__'),
    );
    const declared = new Set(DETECTIVE_STORES.map((store) => store.entity));
    const offenders = others.filter((file) => {
      const source = code(file);
      return [...source.matchAll(/private readonly (\w+): Repository<(LoginAttempt|ApiUsageLog)>/g)]
        .filter(([, field]) => new RegExp(`this\\.${field!}\\.count\\(`).test(source))
        .some(([, , entity]) => !declared.has(entity!));
    });
    expect(offenders).toEqual([]);
  });
});
