/**
 * INVARIANT: farm-AI query contract SSOT (PR-3, Water & Health specialist).
 *
 * Binds every layer of the `request.farm.ai.*` read-only surface to the
 * single contract at libs/event-contracts/src/farm-ai-queries.ts:
 *
 *   1. ACL: every PR-3 subject is granted EXPLICITLY (exact string, never a
 *      wildcard token) in farm_service.subscribe AND ai_service.publish of
 *      infrastructure/nats/services.yaml — a wildcard grant would silently
 *      widen if the contract ever grows.
 *   2. Responder: farm-service registers a @MessagePattern for each of the
 *      13 PR-3 keys — a subject in the contract nobody answers is a
 *      guaranteed ai-service timeout.
 *   3. Caller: ai-service's tools/farm tree references each subject key at
 *      least once — an unreferenced key is dead contract surface.
 *   4. Read-only namespace: the farm-service responder/projection files
 *      contain NO transaction/command/persistence verbs.
 *   5. Tool metadata: every @Tool under tools/farm declares
 *      requiresModule 'farm' and (except the create-task ACTUATION tool)
 *      requiresConfirmation false — AI read tools never need confirmation.
 *   6. PII: the contract's request DTOs carry no banned identity/free-text
 *      field names.
 *
 * House style: plain fs reads + regex assertions (see
 * tenant-provisioning-ssot.spec.ts) — no app bootstrap, runs in layer-1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/** Comments are prose ("…no CommandBus…") — only code carries the invariant. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Recursively list .ts files under a repo dir (skips __tests__). */
function listSourceFiles(path: string): string[] {
  const absolute = resolve(REPO_ROOT, path);
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const childPath = `${path}/${entry}`;
    const stats = statSync(resolve(absolute, entry));
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...listSourceFiles(childPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) files.push(childPath);
  }
  return files;
}

interface Service {
  name: string;
  publish: string[];
  subscribe: string[];
}

function loadServicesYaml(): { services: Service[] } {
  const text = readRepoFile('infrastructure/nats/services.yaml');
  return yamlParse(text) as { services: Service[] };
}

const CONTRACT = readRepoFile('libs/event-contracts/src/farm-ai-queries.ts');

/** The 13 PR-3 keys, lifted from the contract file itself. */
const PR3_KEYS = [
  'WQ_TANK_STATS',
  'WQ_SYSTEM_STATS',
  'WQ_HISTORY',
  'WQ_CRITICAL',
  'WQ_THRESHOLDS',
  'FH_STATS',
  'FH_EVENTS',
  'FH_CRITICAL',
  'FH_OVERDUE_FOLLOW_UPS',
  'FH_LICE_COUNTS',
  'FH_TREATMENTS',
  'FH_WELFARE',
  'FH_HARVEST_ELIGIBILITY',
] as const;

/** KEY: 'subject' pairs straight out of the contract source. */
function contractSubjects(): Map<string, string> {
  const subjects = new Map<string, string>();
  for (const match of CONTRACT.matchAll(/([A-Z][A-Z0-9_]+):\s*'(request\.farm\.ai\.[^']+)'/g)) {
    subjects.set(match[1], match[2]);
  }
  return subjects;
}

const RESPONDER_FILES = [
  'apps/farm-service/src/common/nats/ai-query-responder.ts',
  'apps/farm-service/src/water-quality/responders/water-quality-ai-query.responder.ts',
  'apps/farm-service/src/water-quality/responders/projections.ts',
  'apps/farm-service/src/fish-health/responders/fish-health-ai-query.responder.ts',
  'apps/farm-service/src/fish-health/responders/projections.ts',
];

/** NATS subject match: exact string, or a `>`/`*` wildcard grant covering it. */
function grantCovers(grant: string, subject: string): boolean {
  if (grant === subject) return true;
  const grantTokens = grant.split('.');
  const subjectTokens = subject.split('.');
  for (let i = 0; i < grantTokens.length; i += 1) {
    const token = grantTokens[i];
    if (token === '>') return true;
    if (token === '*') continue;
    if (token !== subjectTokens[i]) return false;
  }
  return grantTokens.length === subjectTokens.length;
}

const BANNED_PII_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'vet',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
];

describe('INVARIANT: farm-AI query contract SSOT (PR-3 Water & Health)', () => {
  const subjects = contractSubjects();

  it('the contract declares all 13 PR-3 keys in the request.farm.ai namespace', () => {
    for (const key of PR3_KEYS) {
      expect(subjects.has(key)).toBe(true);
      expect(subjects.get(key)).toMatch(/^request\.farm\.ai\.[a-z][A-Za-z]+$/);
    }
  });

  it('grants every PR-3 subject EXPLICITLY (exact entry, never a wildcard) in both ACLs', () => {
    const services = loadServicesYaml().services;
    const farmService = services.find((service) => service.name === 'farm_service');
    const aiService = services.find((service) => service.name === 'ai_service');
    expect(farmService).toBeDefined();
    expect(aiService).toBeDefined();

    for (const key of PR3_KEYS) {
      const subject = subjects.get(key) as string;

      const subscribeHits = (farmService as Service).subscribe.filter((grant) =>
        grantCovers(grant, subject),
      );
      const publishHits = (aiService as Service).publish.filter((grant) =>
        grantCovers(grant, subject),
      );

      // At least one grant covers it…
      expect(subscribeHits.length).toBeGreaterThan(0);
      expect(publishHits.length).toBeGreaterThan(0);
      // …and the covering grant is the EXACT subject (no wildcard shortcuts).
      expect(subscribeHits).toContain(subject);
      expect(publishHits).toContain(subject);
    }
  });

  it('farm-service registers a @MessagePattern for each of the 13 keys', () => {
    const responderSources = [
      readRepoFile('apps/farm-service/src/water-quality/responders/water-quality-ai-query.responder.ts'),
      readRepoFile('apps/farm-service/src/fish-health/responders/fish-health-ai-query.responder.ts'),
    ].join('\n');

    for (const key of PR3_KEYS) {
      expect({
        key,
        pattern: responderSources.includes(`FARM_AI_QUERY_SUBJECTS.${key}`),
      }).toEqual({ key, pattern: true });
    }
  });

  it('ai-service tools/farm references each subject key at least once', () => {
    const toolSources = listSourceFiles('apps/ai-service/src/tools/farm')
      .map((file) => readFileSync(resolve(REPO_ROOT, file), 'utf-8'))
      .join('\n');

    for (const key of PR3_KEYS) {
      expect({
        key,
        referenced: toolSources.includes(`FARM_AI_QUERY_SUBJECTS.${key}`),
      }).toEqual({ key, referenced: true });
    }
  });

  it('the responder namespace stays read-only (no transactions/commands/persistence)', () => {
    const banned =
      /runInTenantTransaction|CommandBus|\.save\(|\.insert\(|\.update\(|\.delete\(/;
    for (const file of RESPONDER_FILES) {
      const source = stripComments(readRepoFile(file));
      const offenders = source.match(banned) ?? [];
      expect({ file, offenders }).toEqual({ file, offenders: [] });
    }
  });

  it('every @Tool under tools/farm requires the farm module; read tools never require confirmation', () => {
    // The single sanctioned actuation exception: create_task is a write tool
    // and MUST keep its human-confirmation gate.
    const ACTUATION_EXCEPTIONS = new Set(['create-task.tool.ts']);

    const toolFiles = listSourceFiles('apps/ai-service/src/tools/farm').filter((file) =>
      file.endsWith('.tool.ts'),
    );
    // 13 PR-3 + 6 pre-existing decorated tools (farm-ai-query.tool.ts is the
    // abstract base — deliberately without @Tool metadata of its own).
    const decorated = toolFiles.filter(
      (file) => stripComments(readRepoFile(file)).includes('@Tool({'),
    );
    expect(decorated.length).toBe(19);

    for (const file of decorated) {
      const source = readRepoFile(file);
      expect({ file, requiresModule: /requiresModule:\s*'farm'/.test(source) }).toEqual({
        file,
        requiresModule: true,
      });

      const fileName = file.split('/').pop() as string;
      const declaresConfirmationGate = /requiresConfirmation:\s*true/.test(source);
      const declaresNoConfirmation = /requiresConfirmation:\s*false/.test(source);
      if (ACTUATION_EXCEPTIONS.has(fileName)) {
        expect({ file, declaresConfirmationGate }).toEqual({
          file,
          declaresConfirmationGate: true,
        });
      } else {
        expect({ file, declaresNoConfirmation }).toEqual({
          file,
          declaresNoConfirmation: true,
        });
      }
    }
  });

  it('contract request DTO keys carry no banned PII field names', () => {
    for (const banned of BANNED_PII_KEYS) {
      // `banned?:` / `banned:` as a property declaration (not a comment word)
      const declared = new RegExp(`(^|\\s)${banned}\\??:`, 'm').test(CONTRACT);
      expect({ banned, declared }).toEqual({ banned, declared: false });
    }
  });
});
