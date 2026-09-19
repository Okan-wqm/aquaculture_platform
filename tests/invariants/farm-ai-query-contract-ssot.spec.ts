import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  FARM_AI_QUERY_NAMESPACE,
  FARM_AI_QUERY_SUBJECTS,
} from '../../libs/event-contracts/src/farm-ai-queries';

/**
 * Platform-wide invariant — FARM-MEDIUM-328 (farm AI read contract SSoT).
 *
 * `libs/event-contracts/src/farm-ai-queries.ts` is the single source of truth
 * for the farm-service → ai-service read subjects. For every subject it
 * declares, this spec proves:
 *   1. it lives in the `request.farm.ai.` namespace and is granted EXPLICITLY
 *      in infrastructure/nats/services.yaml — farm_service.subscribe AND
 *      ai_service.publish (no wildcard: the user chose per-subject grants);
 *   2. exactly one farm-service @MessagePattern handles it;
 *   3. at least one ai-service tool under tools/farm references it;
 *   4. the namespace is READ-ONLY: no responder file that handles one of
 *      these subjects writes (no transaction helper, no command bus, no ORM
 *      write call);
 *   5. every @Tool under tools/farm declares `requiresModule: 'farm'` and,
 *      except the create_task actuation, `requiresConfirmation: false`;
 *   6. no operator/vet/free-text field name crosses the contract DTOs.
 *
 * The e2e RPC-coverage invariant (nats-invariants.spec.ts) checks the
 * @MessagePattern side too; the ai-service tools send through a base class
 * (`this.subject`), which that regex cannot see — (1)+(3) here close the
 * publish side from the contract instead.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function listSourceFiles(path: string): string[] {
  const absolute = resolve(REPO_ROOT, path);
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const childPath = `${path}/${entry}`;
    const stats = statSync(resolve(REPO_ROOT, childPath));
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      files.push(...listSourceFiles(childPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) files.push(childPath);
  }
  return files;
}

interface ServicesManifest {
  services: Array<{ name: string; publish?: string[]; subscribe?: string[] }>;
}

const SUBJECT_ENTRIES = Object.entries(FARM_AI_QUERY_SUBJECTS) as Array<[string, string]>;
const FARM_SOURCES = listSourceFiles('apps/farm-service/src');
const AI_FARM_TOOL_SOURCES = listSourceFiles('apps/ai-service/src/tools/farm');
const CONTRACT_SOURCES = [
  'libs/event-contracts/src/farm-ai-queries.ts',
  ...listSourceFiles('libs/event-contracts/src/farm-ai-queries'),
];

describe('INVARIANT (FARM-MEDIUM-328): farm AI read contract SSoT', () => {
  const manifest = yaml.load(readRepoFile('infrastructure/nats/services.yaml')) as ServicesManifest;
  const farmGrants = manifest.services.find((s) => s.name === 'farm_service')?.subscribe ?? [];
  const aiGrants = manifest.services.find((s) => s.name === 'ai_service')?.publish ?? [];

  it('every subject is in the request.farm.ai. namespace with unique keys and values', () => {
    const values = SUBJECT_ENTRIES.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value.startsWith(FARM_AI_QUERY_NAMESPACE)).toBe(true);
    }
  });

  it.each(SUBJECT_ENTRIES)(
    '%s (%s) is granted explicitly to farm_service.subscribe and ai_service.publish',
    (_key, subject) => {
      expect(farmGrants).toContain(subject);
      expect(aiGrants).toContain(subject);
    },
  );

  it.each(SUBJECT_ENTRIES)('%s has exactly one farm-service @MessagePattern responder', (key) => {
    const pattern = new RegExp(`@MessagePattern\\(FARM_AI_QUERY_SUBJECTS\\.${key}\\)`, 'g');
    let handlers = 0;
    for (const file of FARM_SOURCES) {
      handlers += (readRepoFile(file).match(pattern) ?? []).length;
    }
    expect(handlers).toBe(1);
  });

  it.each(SUBJECT_ENTRIES)('%s is consumed by at least one ai-service farm tool', (key) => {
    const needle = `FARM_AI_QUERY_SUBJECTS.${key}`;
    const consumers = AI_FARM_TOOL_SOURCES.filter((file) => readRepoFile(file).includes(needle));
    expect(consumers.length).toBeGreaterThanOrEqual(1);
  });

  it('the namespace is read-only: responder files never write', () => {
    const writeSignatures = [
      /runInTenantTransaction/,
      /CommandBus/,
      /\.(save|insert|update|delete|softDelete|softRemove|remove|upsert)\s*\(/,
      /\bINSERT\b|\bUPDATE\b|\bDELETE\b/,
    ];
    const responders = FARM_SOURCES.filter((file) =>
      readRepoFile(file).includes('@MessagePattern(FARM_AI_QUERY_SUBJECTS.'),
    );
    expect(responders.length).toBeGreaterThan(0);
    for (const file of responders) {
      const source = readRepoFile(file);
      for (const signature of writeSignatures) {
        expect({ file, write: signature.source, matched: signature.test(source) }).toEqual({
          file,
          write: signature.source,
          matched: false,
        });
      }
    }
  });

  it('every ai-service farm tool is module-scoped and read-only except create_task', () => {
    const toolFiles = AI_FARM_TOOL_SOURCES.filter((file) => readRepoFile(file).includes('@Tool({'));
    expect(toolFiles.length).toBeGreaterThan(0);
    for (const file of toolFiles) {
      const source = readRepoFile(file);
      expect({ file, module: /requiresModule: 'farm'/.test(source) }).toEqual({
        file,
        module: true,
      });
      if (!source.includes("name: 'create_task'")) {
        expect({ file, readOnly: /requiresConfirmation: false/.test(source) }).toEqual({
          file,
          readOnly: true,
        });
      }
    }
  });

  it('no operator, veterinarian or free-text field crosses the contract DTOs', () => {
    // Deliberate exceptions, reviewed: `title` (health events, work orders,
    // tasks) and `location` (tasks) are the operator's one-line names for
    // the item and are needed for the model to reference it; `checklistDone`
    // / `checklistTotal` are counts, not checklist text.
    const banned = [
      'reportedBy',
      'assignedTo',
      'assignedToName',
      'createdBy',
      'completedBy',
      'approvedBy',
      'verifiedBy',
      'countedBy',
      'assessedBy',
      'recordedBy',
      'measuredBy',
      'veterinarianWorkerId',
      'externalVetName',
      'vetName',
      'vetLicense',
      'userName',
      'notes',
      'attachments',
      'specifications',
      'checklist',
    ];
    for (const file of CONTRACT_SOURCES) {
      const source = readRepoFile(file);
      for (const field of banned) {
        const declared = new RegExp(`^\\s*${field}\\??:`, 'm').test(source);
        expect({ file, field, declared }).toEqual({ file, field, declared: false });
      }
    }
  });
});
