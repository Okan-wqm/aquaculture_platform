import { resolve } from 'node:path';

import { FARM_AI_QUERY_SUBJECTS } from '../../libs/event-contracts/src/farm-ai-queries';
import { declaresTool, toolBoundaryViolations } from './helpers/ai-tool-boundary';
import {
  aiRequestSubjects,
  allTs,
  code,
  offenders,
  publishGrants,
  read,
  REPO_ROOT,
  respondersBySubject,
  sources,
} from './helpers/ai-tenant-boundary-sources';

/**
 * Platform-wide invariant — K10 "no AI agent can ever bring back another
 * tenant's data" (PR-T1, MT-HIGH-062 / MT-HIGH-064).
 *
 * The structural layers (types, the tenant-bound envelope, the registry's
 * boot-time schema refusal) make the wrong thing hard; this spec makes the
 * remaining ways around them visible in every PR:
 *
 *   A. ai-service tool code (every file under tools/ and every file that
 *      declares a `@Tool(` class) cannot reach a raw transport: only
 *      TenantBoundNatsClient sends, only the boundary module owns the token,
 *      tools import no transport / HTTP client / TypeORM, name no raw-client
 *      token or DI escape hatch (EVENT_BUS, getRawConnection, NatsEventBus,
 *      ModuleRef, HttpService, global fetch), call `.request(` only on their
 *      injected TenantBoundNatsClient, inject nothing else, and write no
 *      `tenantId` property. The checks are an AST walk
 *      (helpers/ai-tool-boundary.ts) and gate every PR even though ai-service
 *      ESLint is quarantined to warnings.
 *   B. A TenantBinding is minted in ONE file (tool-context.factory.ts), only
 *      the three trusted entry points import that factory, a binding is
 *      imported as a value only inside tenant-boundary/, is never cast, and
 *      no ToolExecutionContext is assembled by hand.
 *   C. Every AI-facing `request.*` subject ai_service may publish is answered
 *      through the responder skeleton (`respondTenantBound`, wired per service
 *      as a `*AiResponder`), which opens the tenant scope and echoes the
 *      tenant read back from the connection that served the reply.
 *   D. AI Redis keys: every AI key literal lives in a registered key module,
 *      and every builder there puts the tenant first (proved by calling it
 *      with two tenants). Long-lived in-memory state (a process-wide
 *      Map/Set/cache every tenant shares) exists only where a reviewed entry
 *      says why it cannot hand one tenant's data to another.
 *
 * The per-tool schema walk (no tenant/schema parameter at any depth) needs the
 * Nest module graph and lives next to it:
 * apps/ai-service/src/tenant-boundary/__tests__/tool-schema-tenant-free.spec.ts.
 * The data layer behind these responders (runInTenantRead) and the reply check
 * of every non-ai-service consumer are ai-tenant-boundary-data-layer.spec.ts.
 */

const AI_SRC = 'apps/ai-service/src';

describe('INVARIANT (K10 / MT-HIGH-062): AI tenant boundary', () => {
  const aiSources = sources(AI_SRC);
  const TOOL_ROOT = `${AI_SRC}/tools/`;
  // The boundary follows the decorator, not the directory (V-T1a-4).
  const toolSources = aiSources.filter(
    (file) => file.startsWith(TOOL_ROOT) || declaresTool(read(file)),
  );
  const BOUND_CLIENT = `${AI_SRC}/tenant-boundary/tenant-bound-nats.client.ts`;
  const BOUNDARY_MODULE = `${AI_SRC}/tenant-boundary/tenant-boundary.module.ts`;
  const CONTEXT_FACTORY = `${AI_SRC}/tenant-boundary/tool-context.factory.ts`;
  const BINDING = `${AI_SRC}/tenant-boundary/tenant-binding.ts`;

  describe('A. tool code reaches other services only through TenantBoundNatsClient', () => {
    it('every @Tool class lives under the enforced tool root', () => {
      // SCENARIO: a @Tool() class placed outside src/tools/ is still registered by discovery.
      // EXPECTS: none — every tool is subject to the directory-scoped ESLint block too.
      expect(
        aiSources.filter((file) => declaresTool(read(file)) && !file.startsWith(TOOL_ROOT)),
      ).toEqual([]);
    });

    it('tool sources reach no transport, HTTP client, database or DI escape hatch (AST)', () => {
      // SCENARIO: a tool injects ClientProxy / NatsV3Client / 'EVENT_BUS', resolves a provider
      //           through ModuleRef, calls getRawConnection().request(…), fetch(…), node:http,
      //           axios or HttpService, holds a DataSource, or imports the context factory.
      // EXPECTS: none — tenant data reaches a tool only as a tenant-bound reply through
      //          TenantBoundNatsClient (K10 layers 1 + 3).
      expect(toolSources.length).toBeGreaterThan(50);
      expect(toolSources.flatMap((file) => toolBoundaryViolations(file, read(file)))).toEqual([]);
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
      const grants = publishGrants('ai_service');
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

    it('only the three trusted entry points import the tool-context factory (V-T1a-2)', () => {
      // SCENARIO: tool (or any other) code imports buildServicePrincipalContext and mints a
      //           context for a tenant it chose.
      // EXPECTS: the importers are exactly the chat runner, the confirmed-proposal service and
      //          the sensor-service channel-detection responder.
      expect(
        offenders(aiSources, /from\s+'[^']*tenant-boundary\/tool-context\.factory'/).sort(),
      ).toEqual(
        [
          `${AI_SRC}/actions/action-proposal.service.ts`,
          `${AI_SRC}/agent/agent-runner.service.ts`,
          `${AI_SRC}/sensor-detection/sensor-channel-detection.responder.ts`,
        ].sort(),
      );
    });

    it('a TenantBinding is imported as a value only inside tenant-boundary/', () => {
      const valueImporters = offenders(
        aiSources,
        /import\s*\{[^}]*\bTenantBinding\b[^}]*\}\s*from\s*'[^']*tenant-binding'/,
      ).filter((file) => !/import\s+type\s*\{[^}]*\bTenantBinding\b/.test(read(file)));
      expect(
        valueImporters.filter((file) => !file.startsWith(`${AI_SRC}/tenant-boundary/`)),
      ).toEqual([]);
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

  describe('C. AI-facing responders reply through the responder skeleton', () => {
    const subjects = aiRequestSubjects();
    const handlers = respondersBySubject();

    it('ai_service publishes AI-facing request subjects (sanity)', () => {
      expect(subjects.length).toBeGreaterThanOrEqual(46);
    });

    it.each(subjects)('%s is answered only through the skeleton (.respond)', (subject) => {
      // The skeleton (`*AiResponder` → respondTenantBound) opens the tenant scope,
      // resolves owned ids and names the served tenant; the data-layer spec §E
      // proves each responder injects one and nothing it reaches escapes the scope.
      const bodies = handlers.get(subject) ?? [];
      expect({ subject, responders: bodies.length }).toEqual({ subject, responders: 1 });
      for (const { body } of bodies) {
        expect({ subject, tenantBound: /\.respond\(/.test(body) }).toEqual({
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

    /**
     * Every long-lived Map/Set/LRU cache in the AI roots (class field,
     * constructor-assigned, or module-level), keyed `<file>#<name>`, with WHY
     * one process-wide instance cannot hand one tenant's data to another. A
     * new one fails the next test until it is reviewed and listed here.
     */
    const AI_PROCESS_STATE: Readonly<Record<string, string>> = {
      [`${AI_SRC}/app.module.ts#complexityCache`]:
        'GraphQL operation document -> complexity score; holds no tenant data',
      [`${AI_SRC}/cost/rate-limit.service.ts#localCounters`]:
        'keyed by aiRateLimitKey, whose tenant-first shape the builder test below proves',
      [`${AI_SRC}/cost/token-budget.service.ts#localCounters`]:
        'keyed by aiTokenBudgetKey, whose tenant-first shape the builder test below proves',
      [`${AI_SRC}/agent/providers/anthropic.provider.ts#clients`]:
        'SDK clients keyed by a hash of the API key; a client carries no conversation or tool data',
      [`${AI_SRC}/agent/providers/openai.provider.ts#clients`]:
        'SDK clients keyed by a hash of the API key; a client carries no conversation or tool data',
      [`${AI_SRC}/agent/providers/llm-provider.factory.ts#registry`]:
        'static provider-id -> provider registry built at boot',
      [`${AI_SRC}/tools/tool-registry.service.ts#tools`]: 'static tool registry built at boot',
      [`${AI_SRC}/tools/tool-registry.service.ts#metadataCache`]:
        'static tool metadata built at boot',
      'mcp/farm-management/src/graphql/client.ts#cache':
        'keyed by buildCacheKey, which leads with the session tenant (graphql-client-cache-key.test.ts)',
    };
    const STATE_ROOTS = [...AI_ROOTS, 'mcp/farm-management/src'];
    // A Map/WeakMap/LRU cache, or an EMPTY Set (one that accumulates entries at
    // runtime). A Set built from a literal list is static configuration.
    const CONTAINER = String.raw`new\s+(?:(?:Map|WeakMap|LRUCache)\b|Set\s*(?:<[^>\n]*>)?\(\s*\))`;
    // Type annotations stay on one line, so a match cannot run across members.
    const STATE_PATTERNS = [
      // class field: `private readonly cache = new Map…`
      new RegExp(
        String.raw`^[ \t]+(?:(?:private|protected|public|static|readonly)[ \t]+)+(\w+)[ \t]*(?::[^=;\n]+)?=\s*${CONTAINER}`,
        'gm',
      ),
      // constructor-assigned: `this.registry = new Map…`
      new RegExp(String.raw`this\.(\w+)[ \t]*=\s*${CONTAINER}`, 'g'),
      // module-level: `const complexityCache = new Map…`
      new RegExp(
        String.raw`^(?:export[ \t]+)?(?:const|let)[ \t]+(\w+)[ \t]*(?::[^=;\n]+)?=\s*${CONTAINER}`,
        'gm',
      ),
    ];

    it('every long-lived in-memory map/cache in an AI root is reviewed as tenant-safe', () => {
      // SCENARIO: someone adds `private cache = new Map<string, Reply>()` to an AI service.
      // EXPECTS: it fails until AI_PROCESS_STATE names why it cannot mix tenants.
      const found = new Set<string>();
      for (const file of STATE_ROOTS.flatMap(sources)) {
        const text = code(file);
        for (const pattern of STATE_PATTERNS) {
          for (const match of text.matchAll(pattern)) found.add(`${file}#${match[1] ?? ''}`);
        }
      }
      expect([...found].filter((entry) => !(entry in AI_PROCESS_STATE)).sort()).toEqual([]);
      // Self-expiry: an entry for state that no longer exists is a claim about nothing.
      expect(Object.keys(AI_PROCESS_STATE).filter((entry) => !found.has(entry))).toEqual([]);
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
