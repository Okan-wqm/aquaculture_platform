import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { FARM_AI_QUERY_SUBJECTS } from '../../libs/event-contracts/src/farm-ai-queries';

/**
 * Platform-wide invariant — K10 "no AI agent can ever bring back another
 * tenant's data" (PR-T1, MT-HIGH-062 / MT-HIGH-064).
 *
 * The structural layers (types, the tenant-bound envelope, the registry's
 * boot-time schema refusal) make the wrong thing hard; this spec makes the
 * remaining ways around them visible in every PR:
 *
 *   A. ai-service tool code cannot reach the raw NATS transport: only
 *      TenantBoundNatsClient sends, only the boundary module owns the token,
 *      tools import no transport, and no tool writes a `tenantId` property.
 *   B. A TenantBinding is minted in ONE file (tool-context.factory.ts), is
 *      never cast, and no ToolExecutionContext is assembled by hand.
 *   C. Every AI-facing `request.*` subject ai_service may publish is answered
 *      through `respondTenantBound`, the one skeleton that echoes the tenant
 *      it served.
 *   D. AI Redis keys: every AI key literal lives in a registered key module,
 *      and every builder there puts the tenant first (proved by calling it
 *      with two tenants).
 *
 * The per-tool schema walk (no tenant/schema parameter at any depth) needs the
 * Nest module graph and lives next to it:
 * apps/ai-service/src/tenant-boundary/__tests__/tool-schema-tenant-free.spec.ts.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const AI_SRC = 'apps/ai-service/src';

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/** Non-test TypeScript sources under `path` (skips __tests__, fixtures, specs). */
function sources(path: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, path))) {
    const child = `${path}/${entry}`;
    if (statSync(resolve(REPO_ROOT, child)).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sources(child));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      out.push(child);
    }
  }
  return out;
}

/** Every TypeScript file under `path`, tests included. */
function allTs(path: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, path))) {
    const child = `${path}/${entry}`;
    if (statSync(resolve(REPO_ROOT, child)).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...allTs(child));
    } else if (entry.endsWith('.ts')) {
      out.push(child);
    }
  }
  return out;
}

/** Source with block and line comments removed (string contents kept). */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function offenders(files: string[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(code(file)));
}

describe('INVARIANT (K10 / MT-HIGH-062): AI tenant boundary', () => {
  const aiSources = sources(AI_SRC);
  const toolSources = sources(`${AI_SRC}/tools`);
  const BOUND_CLIENT = `${AI_SRC}/tenant-boundary/tenant-bound-nats.client.ts`;
  const BOUNDARY_MODULE = `${AI_SRC}/tenant-boundary/tenant-boundary.module.ts`;
  const CONTEXT_FACTORY = `${AI_SRC}/tenant-boundary/tool-context.factory.ts`;
  const BINDING = `${AI_SRC}/tenant-boundary/tenant-binding.ts`;

  describe('A. tool code reaches other services only through TenantBoundNatsClient', () => {
    it('tool sources import no NATS transport and name no raw client token', () => {
      // SCENARIO: a tool that injects ClientProxy / NatsV3Client / 'NATS_SERVICE' could build its own payload.
      // EXPECTS: none of the transport entry points appears under tools/.
      expect(toolSources.length).toBeGreaterThan(50);
      expect(
        offenders(
          toolSources,
          /@nestjs\/microservices|@aquaculture\/backend-common\/nats|\bClientProxy\b|\bNatsV3Client\b|['"]NATS_SERVICE['"]|AI_TENANT_BOUND_TRANSPORT/,
        ),
      ).toEqual([]);
    });

    it('only TenantBoundNatsClient calls .send on a NATS client in ai-service', () => {
      expect(offenders(aiSources, /\.send\s*[<(]/)).toEqual([BOUND_CLIENT]);
    });

    it('only the boundary module and the client name the raw transport token', () => {
      expect(offenders(aiSources, /AI_TENANT_BOUND_TRANSPORT/).sort()).toEqual(
        [BOUNDARY_MODULE, BOUND_CLIENT].sort(),
      );
    });

    it('no tool writes a tenantId property — the client injects the bound tenant', () => {
      expect(offenders(toolSources, /\btenantId\s*:/)).toEqual([]);
    });

    it('every subject a tool requests is granted to ai_service.publish', () => {
      // WHY: tools name their subject in the TenantBoundNatsClient call, which the
      // generic `.send(` scan of e2e/tests/integration/nats-invariants.spec.ts cannot
      // see — a subject missing its grant would time out at runtime, silently.
      interface Manifest {
        services: Array<{ name: string; publish?: string[] }>;
      }
      const grants =
        (yaml.load(read('infrastructure/nats/services.yaml')) as Manifest).services.find(
          (service) => service.name === 'ai_service',
        )?.publish ?? [];
      const constants = new Map<string, string>(Object.entries(FARM_AI_QUERY_SUBJECTS));
      const requested = new Set<string>();
      for (const file of toolSources) {
        const text = code(file);
        for (const match of text.matchAll(/subject:\s*'([^']+)'/g)) requested.add(match[1] ?? '');
        for (const match of text.matchAll(/subject\s*=\s*FARM_AI_QUERY_SUBJECTS\.([A-Z_]+)/g)) {
          requested.add(constants.get(match[1] ?? '') ?? `unresolved:${match[1]}`);
        }
      }
      expect(requested.size).toBeGreaterThanOrEqual(46);
      expect([...requested].filter((subject) => !grants.includes(subject))).toEqual([]);
    });
  });

  describe('B. tenant bindings are minted once and never forged', () => {
    it('TenantBinding.fromTrustedRequest is called only by the tool-context factory', () => {
      expect(offenders(aiSources, /TenantBinding\.fromTrustedRequest\s*\(/)).toEqual([
        CONTEXT_FACTORY,
      ]);
    });

    it('no code anywhere in ai-service (tests included) casts to TenantBinding', () => {
      const files = allTs(AI_SRC).filter((file) => file !== BINDING);
      expect(offenders(files, /\bas\s+TenantBinding\b|<TenantBinding>/)).toEqual([]);
    });

    it('no ToolExecutionContext / TenantBoundToolContext is assembled by hand outside the factory', () => {
      expect(
        offenders(aiSources, /:\s*(ToolExecutionContext|TenantBoundToolContext)\s*=\s*\{/),
      ).toEqual([]);
    });
  });

  describe('C. AI-facing responders reply through respondTenantBound', () => {
    interface ServicesManifest {
      services: Array<{ name: string; publish?: string[] }>;
    }
    const manifest = yaml.load(read('infrastructure/nats/services.yaml')) as ServicesManifest;
    const aiRequestSubjects = (
      manifest.services.find((service) => service.name === 'ai_service')?.publish ?? []
    ).filter((subject) => subject.startsWith('request.'));
    const constantValue = new Map<string, string>(
      Object.entries(FARM_AI_QUERY_SUBJECTS).map(([key, value]) => [
        `FARM_AI_QUERY_SUBJECTS.${key}`,
        value,
      ]),
    );
    const responderSources = readdirSync(resolve(REPO_ROOT, 'apps')).flatMap((app) =>
      statSync(resolve(REPO_ROOT, `apps/${app}/src`), { throwIfNoEntry: false })?.isDirectory()
        ? sources(`apps/${app}/src`)
        : [],
    );

    /** subject → handler bodies (text from its @MessagePattern to the next decorator/class end). */
    const handlers = new Map<string, string[]>();
    for (const file of responderSources) {
      const text = code(file);
      if (!text.includes('@MessagePattern(')) continue;
      const decorators = [...text.matchAll(/@MessagePattern\(\s*([^)]+?)\s*\)/g)];
      decorators.forEach((match, index) => {
        const raw = match[1] ?? '';
        const literal = /^['"]([^'"]+)['"]$/.exec(raw)?.[1];
        const resolved = literal ?? constantValue.get(raw);
        const subjectConst = /^const SUBJECT = ['"]([^'"]+)['"]/m.exec(text)?.[1];
        const subject = resolved ?? (raw === 'SUBJECT' ? subjectConst : undefined);
        if (subject === undefined) return;
        const start = match.index ?? 0;
        const end = decorators[index + 1]?.index ?? text.length;
        handlers.set(subject, [...(handlers.get(subject) ?? []), text.slice(start, end)]);
      });
    }

    it('ai_service publishes AI-facing request subjects (sanity)', () => {
      expect(aiRequestSubjects.length).toBeGreaterThanOrEqual(46);
    });

    it.each(aiRequestSubjects)('%s is answered only through respondTenantBound', (subject) => {
      const bodies = handlers.get(subject) ?? [];
      expect({ subject, responders: bodies.length }).toEqual({ subject, responders: 1 });
      for (const body of bodies) {
        expect({ subject, tenantBound: body.includes('respondTenantBound(') }).toEqual({
          subject,
          tenantBound: true,
        });
      }
    });
  });

  describe('D. AI Redis keys are tenant-scoped', () => {
    const KEY_MODULES = [
      `${AI_SRC}/cost/ai-redis-keys.ts`,
      'apps/messaging-service/src/ai/ai-redis-keys.ts',
      'apps/farm-service/src/ai-insights/ai-insights-cache-keys.ts',
    ];
    const AI_ROOTS = [AI_SRC, 'apps/messaging-service/src/ai', 'apps/farm-service/src/ai-insights'];
    const AI_KEY_LITERAL = /['"`](?:ai:|ai-insights|msg:ai-)/;

    it('every AI key literal lives in a registered key module', () => {
      // SCENARIO: someone builds `ai:foo:${x}` inline, outside the builders the next test proves.
      // EXPECTS: no AI key literal outside the key modules.
      const files = AI_ROOTS.flatMap(sources).filter((file) => !KEY_MODULES.includes(file));
      expect(offenders(files, AI_KEY_LITERAL)).toEqual([]);
    });

    const TENANT_A = '11111111-1111-4111-8111-111111111111';
    const TENANT_B = '99999999-9999-4999-8999-999999999999';

    it.each(KEY_MODULES)('every builder in %s puts the tenant first', async (modulePath) => {
      // SCENARIO: call each exported builder for two tenants with identical other arguments.
      // EXPECTS: `<family>:<tenant>…` — same family, tenant right after it, keys never equal.
      const builders = Object.entries(
        (await import(resolve(REPO_ROOT, modulePath))) as Record<string, unknown>,
      ).filter(
        (entry): entry is [string, (...args: string[]) => string] => typeof entry[1] === 'function',
      );
      expect(builders.length).toBeGreaterThan(0);
      for (const [name, build] of builders) {
        const rest = ['p1', 'p2', 'p3'];
        const keyA = build(TENANT_A, ...rest);
        const keyB = build(TENANT_B, ...rest);
        const familyA = keyA.split(`:${TENANT_A}`)[0];
        const familyB = keyB.split(`:${TENANT_B}`)[0];
        expect({
          name,
          scoped: keyA.startsWith(`${familyA}:${TENANT_A}`) && familyA !== keyA,
        }).toEqual({
          name,
          scoped: true,
        });
        expect({ name, sameFamily: familyA === familyB, distinct: keyA !== keyB }).toEqual({
          name,
          sameFamily: true,
          distinct: true,
        });
        expect({
          name,
          familyHasNoTenant: !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(familyA ?? ''),
        }).toEqual({
          name,
          familyHasNoTenant: true,
        });
      }
    });
  });
});
